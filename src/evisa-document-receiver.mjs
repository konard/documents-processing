#!/usr/bin/env node

import { logPassportReading, valuesAllowed } from './evisa-log.mjs';
import { withTempFile } from './evisa-bot.mjs';
import { readPassportDocumentInWorker } from './evisa-session.mjs';
import { keepPassport, keepPortrait } from './evisa-documents.mjs';
import { sortUnreadableImage } from './evisa-image-role.mjs';
import { downloadFile, keepForUpload } from './evisa-details.mjs';
import { noteDocumentIssue } from './evisa-document-feedback.mjs';

/** Fields read off the printed side of a passport, which fill gaps only. */
const PRINTED_SIDE = [
  'passportIssueDate',
  'placeOfBirth',
  'passportIssuingAuthority',
];

/** A value for the log, or a note that values are being withheld. */
function shown(value) {
  return valuesAllowed() ? value : '(value withheld)';
}

/** Makes the next form fill reflect the attachment that just landed. */
export function markReceived(session) {
  session.received = (session.received ?? 0) + 1;
  session.toldWhatIsStuck = false;
  session.lastFill = null;
}

/**
 * Builds the document handler with the runner state it shares.
 *
 * Documents are read concurrently, while their reserved commits preserve
 * Telegram message order. Every exit releases its commit slot.
 */
export function createDocumentReceiver({
  sessions,
  touch,
  refuseIfPastForm,
  showStatus,
  token,
  log,
  holdIdleFill,
  transcript,
  tookArrivalDocument,
}) {
  async function readDocument(ctx, commit) {
    const chatId = ctx.chat.id;
    const session = sessions.get(chatId);
    touch(chatId);
    if (await refuseIfPastForm(ctx, session)) {
      return;
    }
    const busy = showStatus(ctx, 'typing');

    let buffer;
    let extension;
    try {
      ({ buffer, extension } = await downloadFile(ctx, token));
    } catch (error) {
      busy();
      log(chatId, error.message);
      await commit(() => {
        noteDocumentIssue(session, 'downloadFailed');
        markReceived(session);
      });
      holdIdleFill(ctx, chatId);
      return;
    }
    const kb = Math.round(buffer.length / 1024);
    log(chatId, `document received: ${extension}, ${kb} KB`);
    // Kept beside the transcript under its own name, so the picture that
    // caused a misreading can be read again in a later session.
    const kept = transcript.keepFile(
      chatId,
      buffer,
      `${ctx.message.document?.file_name ?? 'photo'}${
        ctx.message.document?.file_name ? '' : extension
      }`
    );
    if (kept) {
      log(chatId, `document kept for the transcript at ${kept}`);
    }
    const compressedPhoto = Boolean(ctx.message.photo);
    if (compressedPhoto) {
      // Telegram shrinks a photo and strips what the camera wrote; the site
      // then doubts the portrait. The batch answer says this once, while
      // every file is still used whether or not it was compressed.
      log(chatId, 'sent as a photo, not a file; noted for the batch answer');
    }

    // Granted e-visas and airline tickets carry text in their PDFs. Reading
    // them as pictures yields incidental logos and QR codes instead.
    if (extension === '.pdf') {
      const took = await withTempFile(buffer, extension, (local) =>
        tookArrivalDocument(ctx, chatId, local, (work) =>
          commit(async () => {
            if (compressedPhoto) {
              noteDocumentIssue(session, 'compressedPhoto');
            }
            await work();
            markReceived(session);
          })
        )
      );
      if (took) {
        busy();
        holdIdleFill(ctx, chatId);
        return;
      }
    }

    // Kept for inspection while debugging: a bad crop or read is only
    // diagnosable against the image that caused it.
    await withTempFile(
      buffer,
      extension,
      async (local) => {
        log(chatId, `document written to ${local}`);
        // A photo of a whole passport carries background the form has no use
        // for, so the data page is cut out, and both sides of it are read. The
        // reading runs off the main thread, so the chat stays responsive.
        const prepared = `${local}.upload.jpg`;
        const read = await readPassportDocumentInWorker(local, prepared).catch(
          (error) => {
            log(chatId, `reading the document failed: ${error.message}`);
            return null;
          }
        );
        logPassportReading(chatId, read, { log, shown });

        // Two readings finishing together must not write over each other, so
        // what each puts into the session goes in in turn.
        await commit(async () => {
          if (compressedPhoto) {
            noteDocumentIssue(session, 'compressedPhoto');
          }
          if (read && Object.keys(read.data).length) {
            keepPassport(session, read, extension, {
              PRINTED_SIDE,
              keepForUpload,
            });
          } else {
            await sortUnreadableImage({
              chatId,
              session,
              read,
              local,
              extension,
              log,
              shown,
              keepPortrait: (...args) =>
                keepPortrait(...args, { log, keepForUpload }),
              keepForUpload,
              noteIssue: (issue) => noteDocumentIssue(session, issue),
            });
          }
          markReceived(session);
        });
      },
      { keep: valuesAllowed() }
    ).finally(busy);

    // The reading may outlast the quiet window. It keeps that window open
    // for the fill that follows without requesting another fill of its own.
    holdIdleFill(ctx, chatId);
  }

  return async function receiveDocument(ctx, commit) {
    try {
      return await readDocument(ctx, commit);
    } finally {
      // Unknown files and early failures still release the next message.
      await commit();
    }
  };
}
