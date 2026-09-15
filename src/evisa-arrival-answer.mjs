#!/usr/bin/env node
// evisa-arrival-answer.mjs
//
// One readable Telegram answer for one declaration page. Page images are
// deliberately never combined: each checkpoint must remain legible, and the
// instruction that advances it belongs at the very bottom of its caption.

import {
  describeDocumentIssues,
  restoreDocumentIssues,
  takeDocumentIssues,
} from './evisa-document-feedback.mjs';

/** Telegram's limit on the words under a picture. */
const CAPTION_LIMIT = 1024;

/** Builds the caption and image for exactly one declaration checkpoint. */
// The branches are the three page kinds and their terminal safety states.
// eslint-disable-next-line complexity
export function arrivalAnswerFor({
  capture = {},
  session,
  strings,
  describeFilled,
  ready = false,
  refused = [],
  rehearsal = '',
  tooEarly = null,
  expired = false,
}) {
  const values = reportableValues(capture);
  const at = capture.at ?? 0;
  const title = strings.arrivalPageName?.(capture.title) ?? capture.title;
  const result = capture.result ?? { filled: [], missing: [], failed: [] };
  const summary =
    at === 0
      ? strings.arrivalPassengerCheck?.(escapedValues(values))
      : at === 1
        ? strings.arrivalTripCheck?.(escapedValues(values))
        : '';
  const status = arrivalPageStatus({
    at,
    ready,
    refused,
    tooEarly,
    expired,
    title,
    result,
    values,
    reviewConfirmed: capture.reviewConfirmed !== false,
    session,
    strings,
    describeFilled,
  });
  const caption = [
    rehearsal,
    strings.arrivalPageOf(at + 1, 3, title),
    tooEarly || expired ? '' : summary,
    status.details,
    describeArrivalWarnings(capture, strings),
    describeDocumentIssues(session, strings),
    status.instruction,
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    caption,
    shot: capture.shot ?? null,
    instruction: status.instruction,
  };
}

/** Non-blocking fill failures that belong beside the page where they arose. */
function describeArrivalWarnings(capture, strings) {
  const failed = capture.result?.failed ?? [];
  return failed.some((failure) =>
    /^passportImage:\s*the site read nothing from it$/i.test(
      String(failure).trim()
    )
  )
    ? strings.arrivalPassportUnread
    : '';
}

/** The details and final instruction for one page, kept as separate blocks. */
function arrivalPageStatus({
  at,
  ready,
  refused,
  tooEarly,
  expired,
  title,
  result,
  values,
  reviewConfirmed,
  session,
  strings,
  describeFilled,
}) {
  if (tooEarly) {
    return {
      details: '',
      instruction: strings.arrivalTooEarly(tooEarly.wanted, tooEarly.offered),
    };
  }
  if (expired) {
    return { details: '', instruction: strings.arrivalExpired };
  }
  if (ready) {
    return {
      details: '',
      instruction:
        at === 2
          ? reviewConfirmed
            ? strings.arrivalReviewReady
            : strings.arrivalReviewSafetyUnknown
          : strings.arrivalPageReady,
    };
  }
  const actionable = Boolean(
    result.missing?.length || result.failed?.length || refused.length
  );
  return {
    details: actionable
      ? describeFilled(values, result, session.language, {
          showValues: false,
          forceNeedsWork: true,
          showStatus: false,
        })
      : '',
    instruction: actionable
      ? refused.length
        ? strings.arrivalPageRefused(title, [])
        : strings.arrivalPageIncomplete(title)
      : strings.arrivalPageRetry,
  };
}

/** Sends one page and retires only the warnings present in its caption. */
export async function sendArrivalAnswer({
  ctx,
  chatId,
  answer,
  session,
  strings,
  InputFile,
  log,
}) {
  // The answer was built synchronously immediately before this snapshot.
  // Later warnings get a new collection and survive while Telegram is busy.
  const issueSnapshot = takeDocumentIssues(session);
  try {
    const shot = answer.shot ?? null;
    if (shot && InputFile) {
      const fits = answer.caption.length <= CAPTION_LIMIT;
      const caption = fits
        ? answer.caption
        : shortenCaption(answer.caption, answer.instruction);
      if (!fits) {
        log(
          chatId,
          `the arrival page caption is ${answer.caption.length} characters; shortened under its screenshot`
        );
      }
      await ctx.replyWithPhoto(new InputFile(shot, strings.arrivalShotName), {
        caption,
        ...(fits ? { parse_mode: 'HTML' } : {}),
        show_caption_above_media: false,
      });
    } else {
      await ctx.reply(answer.caption, { parse_mode: 'HTML' });
    }
    return true;
  } catch (error) {
    restoreDocumentIssues(session, issueSnapshot);
    log(chatId, `the declaration answer did not send: ${error.message}`);
    return false;
  }
}

/** Markup-free fallback for a pathological Telegram caption. */
function plainCaption(caption) {
  return String(caption)
    .replace(/<[^>]*>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

/** Shortens exceptional captions without cutting off the action at the end. */
function shortenCaption(caption, instruction = '') {
  const plain = plainCaption(caption);
  const tail = plainCaption(instruction);
  if (!tail || !plain.endsWith(tail)) {
    return `${plain.slice(0, CAPTION_LIMIT - 1)}…`;
  }
  const join = '\n\n';
  const room = Math.max(0, CAPTION_LIMIT - tail.length - join.length - 1);
  return `${plain.slice(0, room)}…${join}${tail}`;
}

/** Values interpolated into Telegram HTML without becoming markup. */
function escapedValues(values) {
  const escaped = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value) {
      escaped[key] = String(value)
        .replace(/\s+/g, ' ')
        .trim()
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    }
  }
  return escaped;
}

/** Page values except defaults standing in fields the record still lacks. */
function reportableValues(capture = {}) {
  const missing = new Set(capture.result?.missing ?? []);
  for (const failure of capture.result?.failed ?? []) {
    missing.add(String(failure).split(':')[0].trim());
  }
  const values = Object.fromEntries(
    Object.entries(capture.onThePage ?? {}).filter(([key]) => !missing.has(key))
  );
  for (const key of ['passportImage', 'readTheNotes']) {
    if (capture.result?.filled?.includes(key)) {
      values[key] = true;
    }
  }
  return values;
}
