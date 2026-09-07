#!/usr/bin/env node
// evisa-bot-run.mjs
//
// Runs the Telegram bot defined in evisa-bot.mjs.
//
//   EVISA_BOT_TOKEN=<token from @BotFather> node src/evisa-bot-run.mjs
//
// The bot holds one browser per chat, opened on first contact and reused for
// as long as the chat goes on, so the applicant sees the same form growing as
// they send documents. It fills but never submits.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from './env.mjs';
import {
  log,
  describeFields,
  announce,
  valuesAllowed,
  sweepKeptFiles,
  RETENTION_DAYS,
} from './evisa-log.mjs';
import {
  MESSAGES,
  IDLE_FILL_MS,
  CHAT_TTL_MS,
  detectLanguage,
  describeMissing,
  describeChecklist,
  describeSummary,
  describeCorrections,
  NOT_ASKED,
  parseFreeText,
  createSessionStore,
  withTempFile,
} from './evisa-bot.mjs';
import { normalizeApplicant } from './evisa-data.mjs';
import { readRequiredFields, outstandingFields } from './evisa-required.mjs';
import {
  openForm,
  reopenForm,
  readPassportDocumentInWorker,
  fillAndCapture,
} from './evisa-session.mjs';
import {
  lookupAddress,
  renderVerifiedAddress,
  sameAddress,
} from './evisa-geocode.mjs';

loadEnv();

const token = process.env.EVISA_BOT_TOKEN;
if (!token) {
  console.error(
    'Set EVISA_BOT_TOKEN, either in the environment or in a .env file.\n' +
      'See .env.example. The token comes from @BotFather.'
  );
  process.exit(1);
}

const { Bot, InputFile } = await import('grammy');

const sessions = createSessionStore();
const browsers = new Map();
const timers = new Map();

/** Fields read off the printed side of a passport, which fill gaps only. */
const PRINTED_SIDE = [
  'passportIssueDate',
  'placeOfBirth',
  'passportIssuingAuthority',
];

/** The address fields, each checked against the map when it arrives. */
const ADDRESS_FIELDS = [
  'permanentAddress',
  'contactAddress',
  'emergencyAddress',
];

/** A value for the log, or a note that values are being withheld. */
function shown(value) {
  return valuesAllowed() ? value : '(value withheld)';
}

/** True while a chat's browser is still there to be used. */
function browserAlive(held) {
  return Boolean(held && held.browser.isConnected() && !held.page.isClosed());
}

/**
 * Opens this chat's browser on the form, or returns the one already open.
 *
 * A browser that has gone, because it crashed or was closed, gives way to a
 * new one, and what was uploaded to its page is forgotten so the new page
 * gets it.
 */
async function pageFor(chatId) {
  const held = browsers.get(chatId);
  if (browserAlive(held)) {
    return held.page;
  }
  if (held) {
    log(chatId, 'the browser had gone; opening another');
    await held.browser.close().catch(() => {});
    browsers.delete(chatId);
    sessions.get(chatId).uploaded = {};
  }
  log(chatId, 'opening a browser on the form');
  const { browser, page } = await openForm({ headless: true });
  browsers.set(chatId, { browser, page });
  return page;
}

/** Closes a chat's browser and forgets everything held for it. */
async function endChat(chatId) {
  const held = browsers.get(chatId);
  if (held) {
    await held.browser.close().catch(() => {});
    browsers.delete(chatId);
  }
  sessions.clear(chatId);
  disarmIdleFill(chatId);
}

/**
 * Starts a chat over: its data is forgotten and its form emptied.
 *
 * The browser is kept when it is still alive, since opening one takes
 * longer than reloading the form in it. One that has gone is closed and a
 * new one opens on first use.
 */
async function restartChat(chatId) {
  disarmIdleFill(chatId);
  sessions.clear(chatId);
  const held = browsers.get(chatId);
  if (!browserAlive(held)) {
    await endChat(chatId);
    return;
  }
  log(chatId, 'reusing the open browser; reopening the form');
  await reopenForm(held.page).catch(async (error) => {
    log(chatId, `could not reopen the form: ${error.message}`);
    await endChat(chatId);
  });
}

/** Notes that a chat is in use, so the sweep leaves its browser alone. */
function touch(chatId) {
  sessions.get(chatId).lastActivity = Date.now();
}

/**
 * Closes the browsers of chats that have gone quiet for the chat lifetime.
 *
 * Each open browser holds a form and a good deal of memory; one nobody has
 * written to in hours is not coming back.
 */
async function sweepIdleChats() {
  const now = Date.now();
  for (const chatId of sessions.ids()) {
    if (now - sessions.get(chatId).lastActivity > CHAT_TTL_MS) {
      log(chatId, 'quiet for five hours; closing its browser');
      await endChat(chatId);
    }
  }
}

/**
 * Copies a document somewhere it will outlive the temporary file it arrived in,
 * since the form is uploaded from it long after the message was handled.
 *
 * The destination is whatever the system reports as its temp directory, so
 * `TMPDIR` decides where these land. In a container that is the mounted volume,
 * which is what makes the documents reachable for diagnosis and subject to the
 * same sweep as the log.
 */
function keepForUpload(source, name) {
  const kept = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-doc-')),
    name
  );
  fs.copyFileSync(source, kept);
  return kept;
}

/**
 * Shows a status in the chat until the returned function is called.
 *
 * Telegram clears a chat action after five seconds, and again whenever the
 * bot sends a message, so it is renewed every three for as long as the work
 * runs. A status says the bot is busy without adding a message the applicant
 * then has to scroll past. The first failure to send it is logged, since a
 * status that silently stops looks like a bot that has.
 */
function showStatus(ctx, action) {
  let stopped = false;
  let failed = false;
  const send = async () => {
    try {
      await ctx.replyWithChatAction(action);
    } catch (error) {
      if (!failed) {
        failed = true;
        log(ctx.chat.id, `chat action "${action}" failed: ${error.message}`);
      }
    }
  };
  (async () => {
    while (!stopped) {
      await send();
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  })();
  return () => {
    stopped = true;
  };
}

/**
 * Fills the form on a chat's page and sends the applicant the captured result.
 *
 * The chat shows "typing" while the form is filled and "sending a file" while
 * the capture goes out, so the applicant knows the bot is at work without a
 * message saying so. A document already on the page is not uploaded again,
 * and a value already told to the applicant is not repeated.
 */
async function fillAndSend(ctx, chatId, page) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `evisa-shot-${chatId}-`));
  try {
    const busy = showStatus(ctx, 'typing');
    let result;
    try {
      const applicant = normalizeApplicant(session.data);
      log(chatId, `filling with: ${describeFields(applicant)}`);
      // Show what will go on the form, before showing the form itself, and
      // only what has not been shown before.
      const summary = describeSummary(
        applicant,
        session.data,
        session.language,
        session.reported
      );
      if (summary) {
        await ctx.reply(summary, { parse_mode: 'HTML' });
      }
      for (const [key, value] of Object.entries(applicant)) {
        if (value) {
          session.reported[key] = value;
        }
      }

      const uploads = {};
      for (const [key, file] of Object.entries(session.uploads)) {
        if (session.uploaded[key] !== file) {
          uploads[key] = file;
        }
      }
      result = await fillAndCapture(page, applicant, {
        uploads,
        screenshot: path.join(dir, 'form.png'),
      });
      for (const key of Object.keys(uploads)) {
        if (result.filled.includes(key)) {
          session.uploaded[key] = uploads[key];
        }
      }
    } finally {
      busy();
    }

    // Sent as a file: Telegram shrinks a photo to fit a screen, and a page
    // several screens tall comes out too small to read.
    const sending = showStatus(ctx, 'upload_document');
    try {
      await ctx.replyWithDocument(
        new InputFile(result.screenshot, 'form.png'),
        { caption: strings.filled(result.filled.length) }
      );
    } finally {
      sending();
    }
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes what a fill did to the log, one line per thing worth knowing. */
function logFill(chatId, result) {
  log(
    chatId,
    `filled ${result.filled.length} (typed ${result.typed?.length ?? 0})` +
      `, failed ${result.failures.length}` +
      `, site agreed on ${result.agreed?.length ?? 0}` +
      `, corrected ${result.corrected?.length ?? 0}` +
      `, set again ${result.refilled?.length ?? 0}`
  );
  for (const failure of result.failures) {
    log(
      chatId,
      `could not fill ${failure.field}: ${failure.error.split('\n')[0]}`
    );
  }
  for (const change of result.corrected ?? []) {
    log(chatId, `corrected ${change.field}: site had "${shown(change.was)}"`);
  }
}

/** Fills the form with what the chat has provided and sends back the page. */
async function fillAndShow(ctx, chatId) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  // Opening a browser takes seconds too, and the status covers them.
  const opening = showStatus(ctx, 'typing');
  let page;
  try {
    page = await pageFor(chatId);
  } finally {
    opening();
  }
  const result = await fillAndSend(ctx, chatId, page);
  logFill(chatId, result);

  const corrections = describeCorrections(result, session.language);
  if (corrections) {
    await ctx.reply(corrections);
  }

  for (const failure of result.failures.slice(0, 5)) {
    await ctx.reply(
      strings.failed(failure.field, failure.error.split('\n')[0])
    );
  }

  // Ask the page itself what is still required, so a change on their side
  // surfaces as a question to the applicant.
  const report = await readRequiredFields(page);
  const outstanding = outstandingFields(report, session.data, NOT_ASKED);
  log(
    chatId,
    `still outstanding: ${outstanding.map((f) => f.name).join(', ') || 'nothing'}`
  );
  if (report.unmapped.length) {
    // The form has grown a required field this tool does not know about.
    log(
      chatId,
      `required but unmapped: ${report.unmapped.map((u) => u.label).join(' | ')}`
    );
  }
  if (outstanding.length) {
    await ctx.reply(describeMissing(outstanding, session.language));
  } else {
    await ctx.reply(strings.ready);
  }
}

/** Stops a chat's quiet timer and the status shown while it runs. */
function disarmIdleFill(chatId) {
  const armed = timers.get(chatId);
  if (armed) {
    clearTimeout(armed.timer);
    armed.stop();
    timers.delete(chatId);
  }
}

/**
 * Restarts the quiet timer that fills the form when the applicant pauses.
 *
 * The chat shows "typing" through the quiet window as well: the fill that
 * follows is already decided, and a status that stops for most of a minute
 * looks like a bot that has stopped answering.
 */
function armIdleFill(ctx, chatId) {
  disarmIdleFill(chatId);
  const stop = showStatus(ctx, 'typing');
  const timer = setTimeout(() => {
    disarmIdleFill(chatId);
    fillAndShow(ctx, chatId).catch((error) =>
      ctx.reply(`Could not fill the form: ${error.message}`).catch(() => {})
    );
  }, IDLE_FILL_MS);
  timers.set(chatId, { timer, stop });
}

/**
 * Checks an address that just arrived against the map, and keeps the map's
 * rendering when it confirms the house. An address the map cannot place is
 * kept as written and rendered from that at fill time.
 *
 * Two addresses the map places at the same flat of the same house are the
 * same address, however each was written, and the log says so.
 */
async function verifyAddress(chatId, session, field) {
  const written = session.data[field];
  const found = await lookupAddress(written);
  session.resolved ??= {};
  session.resolved[field] = found;
  const verified = renderVerifiedAddress(written, found);
  if (verified) {
    log(chatId, `${field} confirmed by the map: ${shown(verified)}`);
    session.data[field] = verified;
    for (const [other, resolved] of Object.entries(session.resolved)) {
      if (other !== field && sameAddress(found, resolved)) {
        log(chatId, `${field} is the same address as ${other}`);
      }
    }
    return;
  }
  const nearest = found
    ? `; nearest on the map: ${shown(`${found.street} ${found.houseNumber}, ${found.postalCode}`)}`
    : '';
  log(chatId, `${field} not confirmed by the map${nearest}`);
}

const bot = new Bot(token);

bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  log(chatId, `/start from language_code=${ctx.from?.language_code ?? '?'}`);
  await restartChat(chatId);
  const session = sessions.get(chatId);
  session.language = detectLanguage(null, ctx.from?.language_code);
  touch(chatId);

  // The checklist is read from the live form and sent as one message.
  const page = await pageFor(chatId);
  const report = await readRequiredFields(page);
  await ctx.reply(describeChecklist(report.required, session.language));
  // No timer yet: filling an empty form would tell the applicant nothing.
});

bot.command('fill', async (ctx) => {
  touch(ctx.chat.id);
  await fillAndShow(ctx, ctx.chat.id);
});

bot.command('reset', async (ctx) => {
  await endChat(ctx.chat.id);
  await ctx.reply('Cleared. Send /start to begin again.');
});

bot.on(['message:photo', 'message:document'], async (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);
  touch(chatId);
  const busy = showStatus(ctx, 'typing');

  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const buffer = Buffer.from(await (await fetch(url)).arrayBuffer());
  const extension = path.extname(file.file_path || '.jpg') || '.jpg';
  log(
    chatId,
    `document received: ${extension}, ${Math.round(buffer.length / 1024)} KB`
  );

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
      if (read) {
        log(
          chatId,
          `prepared: ${read.prepared.cropped ? 'data page cut out' : 'kept whole'}, ${Math.round(read.prepared.bytes / 1024)} KB`
        );
        if (read.unverified.length) {
          log(chatId, `check digit failed for: ${read.unverified.join(', ')}`);
        }
      }
      log(
        chatId,
        `read from the document: ${describeFields(read?.data ?? {})}`
      );

      if (read && Object.keys(read.data).length) {
        // The zone's fields replace whatever was held; the printed side's
        // only fill gaps, since a value the applicant typed is surer than a
        // reading of print over a pattern.
        for (const [key, value] of Object.entries(read.data)) {
          if (PRINTED_SIDE.includes(key)) {
            session.data[key] ??= value;
          } else {
            session.data[key] = value;
          }
        }
        session.uploads.passportPage = keepForUpload(
          read.prepared.path,
          `passport${extension}`
        );
      } else {
        log(chatId, 'no passport zone found; treating it as the portrait');
        // Not a passport: treat it as the portrait, which is the other image the
        // form wants and needs no reading.
        session.uploads.portraitPhoto = keepForUpload(
          local,
          `portrait${extension}`
        );
      }
    },
    // Kept while debugging, under the system temp directory. What eventually
    // removes them is the sweep below, which runs daily: a container's volume
    // survives restarts, so nothing else would.
    { keep: valuesAllowed() }
  ).finally(busy);

  armIdleFill(ctx, chatId);
});

bot.on('message:text', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);
  touch(chatId);
  session.language = detectLanguage(ctx.message.text, ctx.from?.language_code);
  const parsed = parseFreeText(ctx.message.text);
  // The text itself is logged too: what was not read out of it is only
  // diagnosable against the words that were sent.
  const text = valuesAllowed()
    ? `: ${JSON.stringify(ctx.message.text)}`
    : ` of ${ctx.message.text.length} characters`;
  log(
    chatId,
    `text message (${session.language})${text}; read: ${describeFields(parsed)}`
  );
  Object.assign(session.data, parsed);

  for (const field of ADDRESS_FIELDS) {
    if (parsed[field]) {
      await verifyAddress(chatId, session, field);
    }
  }
  armIdleFill(ctx, chatId);
});

process.on('SIGINT', async () => {
  for (const chatId of [...browsers.keys()]) {
    await endChat(chatId);
  }
  process.exit(0);
});

console.log('e-visa bot running. Press Ctrl+C to stop.');
announce();

// Kept documents are swept on startup and daily after that, so a machine that
// stays up for weeks does not accumulate everything it was ever sent.
const swept = sweepKeptFiles();
console.log(
  `Kept documents older than ${RETENTION_DAYS} days removed: ${swept}`
);
setInterval(() => sweepKeptFiles(), 24 * 60 * 60 * 1000).unref();
// Browsers of chats that have gone quiet are closed on the same principle.
setInterval(() => sweepIdleChats(), 10 * 60 * 1000).unref();
bot.start();
