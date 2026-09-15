#!/usr/bin/env node

import path from 'node:path';
import { normalizeApplicant } from './evisa-data.mjs';
import { describeFields, keepMarkup } from './evisa-log.mjs';
import { fillBySection, captureForm } from './evisa-session.mjs';
import { recordArrival, recordFill } from './evisa-trace.mjs';

/** True when something has arrived since the last fill, or nothing was filled. */
export function formIsStale(session) {
  return (
    session.filledThrough === undefined ||
    session.filledThrough !== (session.received ?? 0)
  );
}

/** Builds the operation that fills and captures one application page. */
export function createPageFiller({
  sessions,
  trace,
  InputFile,
  log,
  captureSection,
  sendSection,
  sectionName,
}) {
  return async function fillPage(ctx, chatId, page, dir) {
    const session = sessions.get(chatId);
    const received = session.received ?? 0;
    try {
      const applicant = normalizeApplicant(session.data);
      log(chatId, `filling with: ${describeFields(applicant)}`);
      session.filling = true;

      const uploads = {};
      for (const [key, file] of Object.entries(session.uploads)) {
        if (session.uploaded[key] !== file) {
          uploads[key] = file;
        }
      }
      // Record what was on the live page before the automated changes, so
      // edits made by hand in the browser remain visible in the trace.
      const wasOnPage = await recordArrival(
        trace,
        chatId,
        page,
        session.lastPageState
      );
      const result = await fillBySection(page, applicant, {
        uploads,
        capture: (at, title) =>
          captureSection(page, title, path.join(dir, `section-${at}.png`)),
        onSection: (part) =>
          sendSection({
            ctx,
            chatId,
            part,
            log,
            InputFile,
            name: (title) => sectionName(title, session.language),
          }),
      });
      session.lastPageState = await recordFill(trace, chatId, page, {
        before: wasOnPage,
        result,
      });
      result.screenshot = await captureForm(page, path.join(dir, 'form.png'));
      for (const key of Object.keys(uploads)) {
        if (result.filled.includes(key)) {
          session.uploaded[key] = uploads[key];
        }
      }
      await keepMarkup(chatId, page, 'filled-form');
      session.filledThrough = received;
      const wrote = JSON.stringify({
        values: applicant,
        failed: result.failures.map((failure) => failure.field).sort(),
      });
      const repeat = wrote === session.lastFill;
      session.lastFill = wrote;
      return { result, applicant, repeat };
    } finally {
      session.filling = false;
    }
  };
}
