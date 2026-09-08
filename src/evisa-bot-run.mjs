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
  withholdFromLog,
  describeFields,
  announce,
  valuesAllowed,
  sweepKeptFiles,
  RETENTION_DAYS,
} from './evisa-log.mjs';
import {
  MESSAGES,
  IDLE_FILL_MS,
  REVIEW_MS,
  CHAT_TTL_MS,
  detectLanguage,
  describeChecklist,
  describeSummary,
  describeOutcome,
  isConfirmation,
  isCancellation,
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
// Whatever an error message carries, the token never reaches the log.
withholdFromLog(token);

const { Bot, InputFile } = await import('grammy');

const sessions = createSessionStore();
const browsers = new Map();
const timers = new Map();
// Chats waiting out the review pause, each with the function that ends it.
const reviews = new Map();

/**
 * With `EVISA_BOT_HEADED=1` each chat's browser is a visible window, so an
 * operator sitting at the machine can watch a fill and, when it fails, carry
 * on by hand in the same window: a fill that fails leaves its browser open.
 */
const HEADED = process.env.EVISA_BOT_HEADED === '1';

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
  log(
    chatId,
    `opening a ${HEADED ? 'visible' : 'headless'} browser on the form`
  );
  const { browser, page } = await openForm({ headless: !HEADED });
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
  settleReview(chatId, 'stop');
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
  settleReview(chatId, 'stop');
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
 * Waits for the applicant to read the summary, and says how the wait ended:
 * "go" or "stop" from them, or "timeout" when they said nothing.
 */
function reviewPause(chatId) {
  return new Promise((resolve) => {
    const finish = (verdict) => {
      clearTimeout(timer);
      reviews.delete(chatId);
      resolve(verdict);
    };
    const timer = setTimeout(() => finish('timeout'), REVIEW_MS);
    reviews.set(chatId, finish);
  });
}

/** Ends a chat's review pause with the verdict; false when none is running. */
function settleReview(chatId, verdict) {
  const finish = reviews.get(chatId);
  if (!finish) {
    return false;
  }
  finish(verdict);
  return true;
}

/**
 * Tells the applicant what will go on the form, waits for them to read it,
 * then fills the form and captures the page into `dir`. Returns null when
 * the applicant stopped it during the wait.
 *
 * The chat shows "typing" throughout, so the applicant knows the bot is at
 * work without a message saying so. A document already on the page is not
 * uploaded again, and a value already told to the applicant is not repeated.
 * With nothing new to tell, there is nothing to review, and no wait.
 */
async function fillPage(ctx, chatId, page, dir, review) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  const busy = showStatus(ctx, 'typing');
  try {
    const applicant = normalizeApplicant(session.data);
    log(chatId, `filling with: ${describeFields(applicant)}`);
    const summary = describeSummary(
      applicant,
      session.data,
      session.language,
      session.reported
    );
    if (summary) {
      const note = review ? `\n\n${strings.reviewNote(REVIEW_MS / 1000)}` : '';
      await ctx.reply(summary + note, { parse_mode: 'HTML' });
    }
    for (const [key, value] of Object.entries(applicant)) {
      if (value) {
        session.reported[key] = value;
      }
    }
    if (summary && review) {
      const verdict = await reviewPause(chatId);
      log(chatId, `review pause ended: ${verdict}`);
      if (verdict === 'stop') {
        return null;
      }
    }
    session.filling = true;

    const uploads = {};
    for (const [key, file] of Object.entries(session.uploads)) {
      if (session.uploaded[key] !== file) {
        uploads[key] = file;
      }
    }
    const result = await fillAndCapture(page, applicant, {
      uploads,
      screenshot: path.join(dir, 'form.png'),
    });
    for (const key of Object.keys(uploads)) {
      if (result.filled.includes(key)) {
        session.uploaded[key] = uploads[key];
      }
    }
    return result;
  } finally {
    session.filling = false;
    busy();
  }
}

/**
 * Sends the captured page with everything there is to say about the fill
 * under it, as one message.
 *
 * Sent as a file: Telegram shrinks a photo to fit a screen, and a page
 * several screens tall comes out too small to read.
 */
async function sendOutcome(ctx, chatId, result, outstanding) {
  const session = sessions.get(chatId);
  const caption = describeOutcome(result, outstanding, session.language);
  const sending = showStatus(ctx, 'upload_document');
  try {
    await ctx.replyWithDocument(new InputFile(result.screenshot, 'form.png'), {
      caption,
    });
  } finally {
    sending();
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

/**
 * Fills the form with what the chat has provided and sends back the page.
 *
 * With `review`, the applicant gets the review pause after the summary.
 * Whatever goes wrong, the browser stays open with the form as far as it
 * got: that is where an operator or the applicant carries on by hand.
 */
async function fillAndShow(ctx, chatId, review) {
  const session = sessions.get(chatId);
  // Opening a browser takes seconds too, and the status covers them.
  const opening = showStatus(ctx, 'typing');
  let page;
  try {
    page = await pageFor(chatId);
  } finally {
    opening();
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `evisa-shot-${chatId}-`));
  try {
    const result = await fillPage(ctx, chatId, page, dir, review);
    if (!result) {
      return;
    }
    logFill(chatId, result);

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
    await sendOutcome(ctx, chatId, result, outstanding);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
    fillNow(ctx, chatId, { review: true });
  }, IDLE_FILL_MS);
  timers.set(chatId, { timer, stop });
}

/**
 * Fills, and tells the chat when that fails.
 *
 * A fill the quiet timer starts gives the applicant the review pause; one
 * they asked for by name does not. The failure is logged whole, and the
 * browser is left as it is: the form with whatever got onto it is worth
 * more to the applicant than a fresh one.
 */
async function fillNow(ctx, chatId, { review = false } = {}) {
  disarmIdleFill(chatId);
  const session = sessions.get(chatId);
  // One fill at a time on a chat's page: a second asked for while one runs
  // waits its turn, since two would type over each other.
  const turn = (session.fillChain ?? Promise.resolve()).then(async () => {
    try {
      await fillAndShow(ctx, chatId, review);
    } catch (error) {
      log(chatId, `filling failed: ${error.stack ?? error.message}`);
      const strings = MESSAGES[sessions.get(chatId).language];
      await ctx
        .reply(strings.fillFailed(error.message.split('\n')[0]))
        .catch(() => {});
    }
  });
  // The chain stays settled whatever a fill did, so the next one still runs.
  session.fillChain = turn.catch(() => {});
  await turn;
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

/**
 * "Стой": nothing is filled until the applicant says otherwise.
 *
 * A fill that has already started is not interrupted, since a half-filled
 * form is not a danger: nothing submits it. The applicant is told so.
 */
async function stopFilling(ctx, chatId) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  if (session.filling) {
    log(chatId, 'stop received during a fill');
    await ctx.reply(strings.alreadyFilling);
    return;
  }
  const pending = settleReview(chatId, 'stop');
  disarmIdleFill(chatId);
  log(chatId, `stop received; ${pending ? 'review' : 'quiet timer'} ended`);
  await ctx.reply(strings.stopped);
}

bot.command('fill', async (ctx) => {
  touch(ctx.chat.id);
  log(ctx.chat.id, '/fill');
  await fillNow(ctx, ctx.chat.id);
});

bot.command('reset', async (ctx) => {
  await endChat(ctx.chat.id);
  await ctx.reply('Cleared. Send /start to begin again.');
});

/**
 * Runs a chat's messages one at a time, in the order they arrived.
 *
 * Two photos sent together would otherwise be read at once and write their
 * fields over each other; a "стой" sent while a photo is being read must
 * take effect after the reading, not before the timer it is meant to stop
 * has even been set.
 */
function inTurn(chatId, work) {
  const session = sessions.get(chatId);
  const turn = (session.queue ?? Promise.resolve()).then(work, work);
  session.queue = turn.catch(() => {});
  return turn;
}

/** Downloads a file Telegram holds, without letting the token into an error. */
async function downloadFile(ctx) {
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url).catch((error) => {
    throw new Error(`could not download the file: ${error.message}`);
  });
  if (!response.ok) {
    throw new Error(`could not download the file: HTTP ${response.status}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    extension: path.extname(file.file_path || '.jpg') || '.jpg',
  };
}

/**
 * Takes a passport's reading into the chat's data and its page for upload.
 *
 * The zone's fields replace whatever was held; the printed side's only fill
 * gaps, since a value the applicant typed is surer than a reading of print
 * over a pattern.
 */
function keepPassport(session, read, extension) {
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
}

/**
 * Keeps an image with no passport in it as the portrait, which is the other
 * image the form wants and needs no reading.
 *
 * The prepared copy is the file as sent when it fits the site's 2 MB limit,
 * and a shrunk one when it does not, as a camera original sent as a file
 * would not.
 */
function keepPortrait(chatId, session, read, local, extension) {
  const portrait = read?.prepared?.path ?? local;
  if (read?.prepared && !read.prepared.unchanged) {
    log(
      chatId,
      `portrait shrunk to ${Math.round(read.prepared.bytes / 1024)} KB`
    );
  }
  session.uploads.portraitPhoto = keepForUpload(
    portrait,
    `portrait${extension}`
  );
}

bot.on(['message:photo', 'message:document'], (ctx) =>
  inTurn(ctx.chat.id, () => receiveDocument(ctx))
);

async function receiveDocument(ctx) {
  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);
  touch(chatId);
  settleReview(chatId, 'stop');
  const busy = showStatus(ctx, 'typing');

  let buffer;
  let extension;
  try {
    ({ buffer, extension } = await downloadFile(ctx));
  } catch (error) {
    busy();
    log(chatId, error.message);
    await ctx.reply(MESSAGES[session.language].unreadable);
    return;
  }
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
        keepPassport(session, read, extension);
      } else {
        log(chatId, 'no passport zone found; treating it as the portrait');
        keepPortrait(chatId, session, read, local, extension);
      }
    },
    // Kept while debugging, under the system temp directory. What eventually
    // removes them is the sweep below, which runs daily: a container's volume
    // survives restarts, so nothing else would.
    { keep: valuesAllowed() }
  ).finally(busy);

  armIdleFill(ctx, chatId);
}

bot.on('message:text', (ctx) => inTurn(ctx.chat.id, () => receiveText(ctx)));

async function receiveText(ctx) {
  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);
  touch(chatId);
  session.language = detectLanguage(ctx.message.text, ctx.from?.language_code);
  if (isCancellation(ctx.message.text)) {
    await stopFilling(ctx, chatId);
    return;
  }
  if (isConfirmation(ctx.message.text)) {
    // "Подтверждаю", "go": the form is filled now, not after the quiet
    // window or the review pause. Never submitted, whatever the word. The
    // fill runs on its own, so a "стой" sent after it is still heard.
    log(chatId, 'confirmation received; filling now');
    if (!settleReview(chatId, 'go')) {
      fillNow(ctx, chatId).catch((error) =>
        log(chatId, `filling failed: ${error.message}`)
      );
    }
    return;
  }
  // New details make a pending fill stale: it is dropped, and the quiet
  // timer starts over with a summary of what changed.
  settleReview(chatId, 'stop');
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
}

// A handler that throws must not stop the bot for every other chat: the
// error is logged with its chat, and the applicant hears that it failed.
bot.catch(async (error) => {
  const chatId = error.ctx?.chat?.id ?? '?';
  const cause = error.error ?? error;
  log(chatId, `handler failed: ${cause.stack ?? cause.message ?? cause}`);
  const language = error.ctx?.chat ? sessions.get(chatId).language : 'en';
  await error.ctx
    ?.reply(MESSAGES[language].fillFailed(String(error.error?.message ?? '')))
    .catch(() => {});
});

process.on('SIGINT', async () => {
  // Browsers get a few seconds to close; one that hangs must not keep the
  // process from exiting.
  const closing = Promise.all([...browsers.keys()].map(endChat));
  const grace = new Promise((resolve) => setTimeout(resolve, 5000));
  await Promise.race([closing, grace]);
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

/**
 * Starts polling, waiting out a predecessor.
 *
 * Telegram allows one poller per token and answers a second with 409 until
 * the first's request ends, which after a restart can be half a minute. A
 * restart should not die in that window, so the start is retried for a
 * while before giving up.
 */
async function startPolling(attempt = 1) {
  try {
    await bot.start();
  } catch (error) {
    if (error.error_code === 409 && attempt <= 12) {
      console.log('another instance still holds the poll; retrying in 5 s');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return startPolling(attempt + 1);
    }
    throw error;
  }
}

startPolling();
