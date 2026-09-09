#!/usr/bin/env node
// evisa-bot-run.mjs
//
// Runs the Telegram bot defined in evisa-bot.mjs.
//
//   EVISA_BOT_TOKEN=<token from @BotFather> node src/evisa-bot-run.mjs
//
// The bot holds one browser per chat, opened on first contact and reused for
// as long as the chat goes on, so the applicant sees the same form growing as
// they send documents. It fills on its own; it presses Next only on the
// applicant's word, after a countdown they can still stop.

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
  SEND_COUNTDOWN_MS,
  CHAT_TTL_MS,
  detectLanguage,
  describeChecklist,
  describeDeclaration,
  describeSummary,
  describeOutcome,
  describeStep,
  isConfirmation,
  looksLikeCaptcha,
  browserHasGone,
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
  advanceAndCapture,
} from './evisa-session.mjs';
import { readCaptcha, refreshCaptcha, fillCaptcha } from './evisa-fill.mjs';
import { createDocuments } from './evisa-documents.mjs';
import { prepareStore, openStore } from './evisa-store.mjs';
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

/**
 * What the bot remembers between runs, kept beside the application.
 *
 * A language the applicant chose, and the application the site registered,
 * must survive both a /start and a restart of the bot.
 */
await prepareStore();
const STORE_DIR =
  process.env.EVISA_BOT_STORE ??
  path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
const store = await openStore(STORE_DIR);

const sessions = createSessionStore();
const browsers = new Map();
const timers = new Map();
// Chats counting down to Next, each with the function that ends the count.
const countdowns = new Map();

/**
 * With `EVISA_BOT_HEADED=1` each chat's browser is a visible window, so an
 * operator sitting at the machine can watch a fill and, when it fails, carry
 * on by hand in the same window: a fill that fails leaves its browser open.
 */
const HEADED = process.env.EVISA_BOT_HEADED === '1';

/**
 * With `EVISA_BOT_CDP_PORT=9222` each chat's browser listens for a
 * debugger on a port of its own from there up, and the log says which:
 * chrome://inspect in another Chrome, or Playwright's connectOverCDP, then
 * attaches to the very browser the bot drives.
 */
const DEBUG_PORT = Number(process.env.EVISA_BOT_CDP_PORT ?? 0) || 0;

/**
 * Writes what the browser reports to the log: console errors and warnings,
 * script errors, requests that failed and answers of 400 and up. When the
 * site draws a page bare, this is where the reason shows.
 */
function logBrowserEvents(chatId, page) {
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      log(chatId, `browser console ${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    log(chatId, `browser script error: ${error.message}`);
  });
  page.on('requestfailed', (request) => {
    log(
      chatId,
      `browser request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? '?'})`
    );
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      log(
        chatId,
        `browser response ${response.status()}: ${response.request().method()} ${response.url()}`
      );
    }
  });
}

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

/**
 * Writes the page's markup to a file beside the kept documents, named for
 * the moment: the empty form, the filled one, the page after Next. When a
 * fill goes wrong, the markup at each point shows whether the site or this
 * code is at fault. Kept on the same terms as the documents, since a filled
 * page holds the applicant's details, and removed by the same sweep.
 */
async function keepMarkup(chatId, page, moment) {
  if (!valuesAllowed()) {
    return;
  }
  try {
    const html = await page.content();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-markup-'));
    const file = path.join(dir, `${moment}.html`);
    fs.writeFileSync(file, html);
    log(chatId, `markup (${moment}) written to ${file}`);
  } catch (error) {
    log(chatId, `could not keep the markup (${moment}): ${error.message}`);
  }
}

/**
 * True within a minute of the chat hearing that its browser closed: a
 * fill that dies of the same closing needs no second message.
 */
function justLostBrowser(chatId) {
  const at = sessions.get(chatId).browserLostAt;
  return Boolean(at) && Date.now() - at < 60_000;
}

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
    held.closing = true;
    await held.browser.close().catch(() => {});
    browsers.delete(chatId);
    sessions.get(chatId).uploaded = {};
  }
  const debugPort = DEBUG_PORT ? DEBUG_PORT + browsers.size : 0;
  const attachable = debugPort
    ? `; a debugger can attach on port ${debugPort}`
    : '';
  log(
    chatId,
    `opening a ${HEADED ? 'visible' : 'headless'} browser on the form${attachable}`
  );
  const { browser, page } = await openForm({ headless: !HEADED, debugPort });
  logBrowserEvents(chatId, page);
  const opened = { browser, page, closing: false };
  browsers.set(chatId, opened);
  // A window the applicant closes, or a browser that crashes, is noticed
  // then and there, not at the next fill: the chat hears, and what was on
  // the page is forgotten so the next fill starts from an empty form.
  const gone = (what) => {
    if (opened.closing || shuttingDown || browsers.get(chatId) !== opened) {
      return;
    }
    browsers.delete(chatId);
    log(chatId, `${what}; the chat is told`);
    const session = sessions.get(chatId);
    session.uploaded = {};
    session.reported = {};
    session.stage = 'form';
    session.captchaEntered = false;
    session.filledThrough = undefined;
    session.browserLostAt = Date.now();
    settleCountdown(chatId, 'stop');
    bot.api
      .sendMessage(chatId, MESSAGES[session.language].browserClosed)
      .catch(() => {});
  };
  page.once('close', () => gone('the window was closed'));
  browser.once('disconnected', () => gone('the browser has gone'));
  await keepMarkup(chatId, page, 'empty-form');
  return page;
}

/** Closes a chat's browser and forgets everything held for it. */
async function endChat(chatId) {
  const held = browsers.get(chatId);
  if (held) {
    held.closing = true;
    await held.browser.close().catch(() => {});
    browsers.delete(chatId);
  }
  // The watch holds a timer of its own, which outlives the session it
  // belongs to unless it is stopped first.
  stopWatchingPayment(chatId);
  sessions.clear(chatId);
  disarmIdleFill(chatId);
  settleCountdown(chatId, 'stop');
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
  settleCountdown(chatId, 'stop');
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
 * Fills the form with the chat's data and captures the page into `dir`.
 * Returns the fill's result with the summary that explains it: what went on
 * the form, grouped by section, or null when nothing new did.
 *
 * The chat shows "typing" throughout, so the applicant knows the bot is at
 * work without a message saying so. A document already on the page is not
 * uploaded again, and a value already explained is not explained again.
 */
async function fillPage(ctx, chatId, page, dir) {
  const session = sessions.get(chatId);
  const busy = showStatus(ctx, 'typing');
  // What arrived before this fill started; what arrives during it is for
  // the next one, and keeps the form counted as changed.
  const received = session.received ?? 0;
  try {
    const applicant = normalizeApplicant(session.data);
    log(chatId, `filling with: ${describeFields(applicant)}`);
    const summary = describeSummary(
      applicant,
      session.data,
      session.language,
      session.reported,
      session.disputed ?? {}
    );
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
    await keepMarkup(chatId, page, 'filled-form');
    // Explained once the page shows it: a fill that failed before the
    // screenshot leaves these to be explained with the next one.
    for (const [key, value] of Object.entries(applicant)) {
      if (value) {
        session.reported[key] = value;
      }
    }
    session.filledThrough = received;
    return { result, summary };
  } finally {
    session.filling = false;
    busy();
  }
}

/**
 * Sends the filled form with the fill's outcome under it, then the
 * explanation of what went where.
 *
 * The form first: it is what the applicant checks, and the explanation reads
 * against it. It goes as a PDF, paged at the same cuts as the pictures, and
 * as those pictures: Telegram shrinks a photo to fit a screen, and a page
 * nine screens tall comes out too small to read either way. The explanation
 * is its own message because Telegram's caption limit would cut a list of
 * forty values short.
 */
async function sendOutcome(ctx, chatId, result, summary, outstanding) {
  const session = sessions.get(chatId);
  const caption = describeOutcome(result, outstanding, session.language);
  const sending = showStatus(ctx, 'upload_document');
  try {
    await sendFormAndSections(ctx, chatId, result.screenshot, caption);
  } finally {
    sending();
  }
  if (summary) {
    await ctx.reply(summary, { parse_mode: 'HTML' });
  }
}

/** How many pictures Telegram accepts in one album. */
const ALBUM_LIMIT = 10;

/**
 * Sends the page as a PDF to keep and as pictures to read.
 *
 * The PDF is the record: one page per section, so a page is never a field
 * split down the middle and a reader opens on a screenful. The pictures are
 * the same sections, which the applicant checks by scrolling the chat without
 * downloading anything.
 *
 * A capture that cannot be cut still goes, as the image itself: the applicant
 * seeing their form matters more than the form it arrives in.
 */
async function sendFormAndSections(ctx, chatId, screenshot, caption) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-slice-'));
  try {
    const { sliceImage, sectionsToPdf } = await import('./evisa-slice.mjs');
    const sections = await sliceImage(screenshot, dir);
    const pdf = await sectionsToPdf(sections, path.join(dir, 'form.pdf'));
    await ctx.replyWithDocument(new InputFile(pdf, 'form.pdf'), { caption });
    for (let at = 0; at < sections.length; at += ALBUM_LIMIT) {
      const album = sections.slice(at, at + ALBUM_LIMIT).map((section) => ({
        type: 'photo',
        media: new InputFile(section.path, `section-${section.index}.jpg`),
        caption: `${section.index}/${section.of}`,
      }));
      await ctx.replyWithMediaGroup(album);
    }
    log(chatId, `sent the form as a PDF and ${sections.length} sections`);
  } catch (error) {
    log(chatId, `could not cut the page into sections: ${error.message}`);
    await ctx.replyWithDocument(new InputFile(screenshot, 'form.png'), {
      caption,
    });
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

/**
 * Fills the form with what the chat has provided and sends back the page.
 *
 * Whatever goes wrong, the browser stays open with the form as far as it
 * got: that is where an operator or the applicant carries on by hand.
 */
async function fillAndShow(ctx, chatId) {
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
    const { result, summary } = await fillPage(ctx, chatId, page, dir);
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
    await sendOutcome(ctx, chatId, result, summary, outstanding);
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
    fillNow(ctx, chatId).catch((error) =>
      log(chatId, `filling failed: ${error.message}`)
    );
  }, IDLE_FILL_MS);
  timers.set(chatId, { timer, stop });
}

/**
 * Fills, and tells the chat when that fails.
 *
 * The failure is logged whole, and the browser is left as it is: the form
 * with whatever got onto it is worth more to the applicant than a fresh one.
 */
async function fillNow(ctx, chatId) {
  disarmIdleFill(chatId);
  const session = sessions.get(chatId);
  // One fill at a time on a chat's page: a second asked for while one runs
  // waits its turn, since two would type over each other.
  const turn = (session.fillChain ?? Promise.resolve()).then(async () => {
    try {
      await fillAndShow(ctx, chatId);
    } catch (error) {
      log(chatId, `filling failed: ${error.stack ?? error.message}`);
      const strings = MESSAGES[sessions.get(chatId).language];
      // A browser that has gone cannot be "left open": the applicant is
      // told to start over, not to look for a window that is not there.
      const text = browserHasGone(error)
        ? strings.browserGone
        : strings.fillFailed(error.message.split('\n')[0]);
      if (!shuttingDown && !justLostBrowser(chatId)) {
        await ctx.reply(text).catch(() => {});
      }
    }
  });
  // The chain stays settled whatever a fill did, so the next one still runs.
  session.fillChain = turn.catch(() => {});
  await turn;
}

/** True when something has arrived since the last fill, or nothing was filled. */
function formIsStale(session) {
  return (
    session.filledThrough === undefined ||
    session.filledThrough !== (session.received ?? 0)
  );
}

/**
 * Waits out the countdown to Next, and says how it ended: "go" or "stop"
 * from the applicant, or "timeout" when they let it run.
 */
function countdown(chatId) {
  return new Promise((resolve) => {
    const finish = (verdict) => {
      clearTimeout(timer);
      countdowns.delete(chatId);
      resolve(verdict);
    };
    const timer = setTimeout(() => finish('timeout'), SEND_COUNTDOWN_MS);
    countdowns.set(chatId, finish);
  });
}

/** Ends a chat's countdown with the verdict; false when none is running. */
function settleCountdown(chatId, verdict) {
  const finish = countdowns.get(chatId);
  if (!finish) {
    return false;
  }
  finish(verdict);
  return true;
}

/**
 * Presses Next and sends back the page it led to, with what happened under
 * it: the stage the site reached, or the same page with the site's own
 * messages on it. On a chat's page, in turn with its fills. Resolves to
 * the step, or null when Next could not be pressed.
 *
 * The stage the page is at is remembered, since what a message means
 * depends on it. Whatever goes wrong, the browser is left as it is.
 */
function pressNextAndShow(ctx, chatId, label = 'Next') {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  const turn = (session.fillChain ?? Promise.resolve()).then(async () => {
    const busy = showStatus(ctx, 'typing');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `evisa-step-${chatId}-`));
    try {
      session.filling = true;
      const page = await pageFor(chatId);
      log(chatId, `pressing ${label} at the ${session.stage ?? 'form'} stage`);
      const step = await advanceAndCapture(
        page,
        path.join(dir, 'page.png'),
        label
      );
      const said = step.notices.length
        ? `; it said: ${step.notices.join(' | ')}`
        : '';
      log(
        chatId,
        step.moved
          ? `the site accepted the page; at the ${step.stage} stage`
          : `the site kept the page; ${step.errors.length} messages on the form${said}`
      );
      session.stage = step.stage;
      await keepMarkup(chatId, page, `after-next-${step.stage}`);
      busy();
      const sending = showStatus(ctx, 'upload_document');
      try {
        await ctx.replyWithDocument(
          new InputFile(step.screenshot, 'page.png'),
          { caption: describeStep(step, session.language) }
        );
      } finally {
        sending();
      }
      return step;
    } catch (error) {
      log(chatId, `pressing ${label} failed: ${error.stack ?? error.message}`);
      const text = browserHasGone(error)
        ? strings.browserGone
        : strings.stepFailed(error.message.split('\n')[0]);
      if (!shuttingDown && !justLostBrowser(chatId)) {
        await ctx.reply(text).catch(() => {});
      }
      return null;
    } finally {
      session.filling = false;
      busy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  session.fillChain = turn.catch(() => {});
  return turn;
}

/**
 * Sends the review page's captcha to the chat as a picture and asks for
 * its code. The picture is small, so it is enlarged to be read on a phone.
 */
async function askCaptcha(ctx, chatId, caption, page = null) {
  const session = sessions.get(chatId);
  const reading = page ?? (await pageFor(chatId));
  const image = await readCaptcha(reading);
  if (!image) {
    log(chatId, 'no captcha on the page');
    return false;
  }
  const { default: sharp } = await import('sharp');
  const enlarged = await sharp(image)
    .resize({ width: 720, kernel: 'nearest' })
    .png()
    .toBuffer();
  session.captchaEntered = false;
  log(chatId, 'captcha sent to the chat');
  await ctx.replyWithPhoto(new InputFile(enlarged, 'captcha.png'), {
    caption,
  });
  return true;
}

const {
  keepRegistration,
  stopWatchingPayment,
  lookUpApplication,
  tookLookupCaptcha,
} = createDocuments({
  sessions,
  browsers,
  store,
  log,
  shown,
  askCaptcha: (...args) => askCaptcha(...args),
  pageFor,
  logBrowserEvents,
  InputFile,
});

/**
 * Takes the page the applicant's word to send led to, and asks for what it
 * needs: the review page wants its captcha, and one that stayed put after
 * Next shows another.
 *
 * The review page has nothing on it to refuse but the code, so a Next that
 * left it where it was means the code was wrong, whether or not the site's
 * toast saying so was caught before it faded. The form is not filled again
 * for that: only the code is asked for, as often as it takes.
 */
async function followStep(ctx, chatId, step) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  if (step?.stage === 'declared') {
    await keepRegistration(ctx, chatId, step);
    return;
  }
  if (!step || step.stage !== 'review') {
    return;
  }
  if (step.moved && step.empty) {
    await refillAfterEmptyReview(ctx, chatId);
    return;
  }
  if (step.moved) {
    await askCaptcha(ctx, chatId, strings.captchaAsk);
    return;
  }
  log(chatId, 'the code was not taken; asking for the next one');
  const page = await pageFor(chatId);
  await refreshCaptcha(page).catch((error) =>
    log(chatId, `could not refresh the captcha: ${error.message}`)
  );
  await askCaptcha(ctx, chatId, strings.captchaAgain);
}

/**
 * The way back from a review page the site left bare: the form is opened
 * again in the same browser, what was on the old page is forgotten, and
 * the fill runs again from what the chat has sent. The applicant then
 * sees the filled form once more and sends it again.
 */
async function refillAfterEmptyReview(ctx, chatId) {
  const session = sessions.get(chatId);
  log(
    chatId,
    'the review page came up empty; reopening the form to fill again'
  );
  const page = await pageFor(chatId);
  await reopenForm(page);
  session.uploaded = {};
  session.reported = {};
  session.filledThrough = undefined;
  session.stage = 'form';
  session.captchaEntered = false;
  await fillNow(ctx, chatId);
}

/**
 * A word to send on the form: Next at once, since the site answers with
 * the application laid out for review and a Back button, and nothing is
 * sent yet.
 */
async function sendForm(ctx, chatId) {
  const step = await pressNextAndShow(ctx, chatId);
  await followStep(ctx, chatId, step);
}

/**
 * The step that sends the application on: a countdown, said in the chat,
 * then Next.
 *
 * The countdown is the one wait in the conversation, and it is here because
 * this is the step that is hard to take back. "Стой" during it drops the
 * step; a second word to send skips the rest of the wait.
 */
async function sendAfterCountdown(ctx, chatId, announcement) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  await ctx.reply(
    announcement ?? strings.sendCountdown(SEND_COUNTDOWN_MS / 1000)
  );
  const verdict = await countdown(chatId);
  log(chatId, `countdown to Next ended: ${verdict}`);
  if (verdict === 'stop') {
    return;
  }
  const step = await pressNextAndShow(ctx, chatId);
  await followStep(ctx, chatId, step);
}

/**
 * The captcha's code, typed into the review page; then the countdown to
 * the Next that sends the application on.
 */
async function enterCaptcha(ctx, chatId, code) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  const page = await pageFor(chatId);
  await fillCaptcha(page, code);
  session.captchaEntered = true;
  log(chatId, 'captcha code typed in');
  await sendAfterCountdown(
    ctx,
    chatId,
    strings.captchaEntered(SEND_COUNTDOWN_MS / 1000)
  );
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
  // Telegram's own language is the default, so most applicants are never
  // asked; the buttons are there for anyone it gets wrong.
  // A language the applicant chose before outlives both the session and the
  // bot; Telegram's guess is only the fallback for a chat never seen.
  const remembered = store.read(chatId, 'language');
  session.language =
    remembered ?? detectLanguage(null, ctx.from?.language_code);
  session.languageChosen = Boolean(remembered);
  touch(chatId);
  await ctx.reply(MESSAGES[session.language].menu, {
    reply_markup: LANGUAGE_BUTTONS,
  });
});

/** The language buttons under the welcome, one per language spoken. */
const LANGUAGE_BUTTONS = {
  inline_keyboard: [
    [
      { text: 'Русский', callback_data: 'language:ru' },
      { text: 'English', callback_data: 'language:en' },
    ],
  ],
};

bot.callbackQuery(/^language:(ru|en)$/, async (ctx) => {
  const chatId = ctx.chat.id;
  const chosen = ctx.match[1];
  const session = sessions.get(chatId);
  session.language = chosen;
  // From here the applicant's choice holds, whatever any later message
  // happens to be written in.
  session.languageChosen = true;
  await store.write(chatId, 'language', chosen);
  touch(chatId);
  log(chatId, `language chosen: ${chosen}, and remembered`);
  await ctx.answerCallbackQuery();
  await ctx.reply(MESSAGES[chosen].menu);
});

bot.command('visa', async (ctx) => {
  const chatId = ctx.chat.id;
  log(chatId, '/visa');
  touch(chatId);
  const session = sessions.get(chatId);
  // The checklist is read from the live form and sent as one message.
  const page = await pageFor(chatId);
  const report = await readRequiredFields(page);
  await ctx.reply(describeChecklist(report.required, session.language));
  // No timer yet: filling an empty form would tell the applicant nothing.
});

bot.command('arrival', async (ctx) => {
  const chatId = ctx.chat.id;
  log(chatId, '/arrival');
  touch(chatId);
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  const { buildDeclaration, fullNameOf } =
    await import('./evisa-prearrival.mjs');
  const applicant = {
    ...(session.data ?? {}),
    fullName: fullNameOf(session.data ?? {}),
  };
  const { values, missing } = buildDeclaration(applicant);
  await ctx.reply(strings.arrivalIntro);
  await ctx.reply(describeDeclaration(values, missing, session.language), {
    parse_mode: 'HTML',
  });
});

/**
 * "Стой": the countdown to Next and the quiet timer are dropped, and
 * nothing is filled or pressed until the applicant says otherwise.
 *
 * A fill that has already started is not interrupted, since a half-filled
 * form is not a danger: Next is not pressed without their word. The
 * applicant is told so.
 */
async function stopFilling(ctx, chatId) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  const counting = settleCountdown(chatId, 'stop');
  if (session.filling && !counting) {
    log(chatId, 'stop received during a fill');
    await ctx.reply(strings.alreadyFilling);
    return;
  }
  disarmIdleFill(chatId);
  log(chatId, `stop received; ${counting ? 'countdown' : 'quiet timer'} ended`);
  await ctx.reply(strings.stopped);
}

/**
 * A word to send: what it does depends on where the chat is.
 *
 * During the countdown it skips the rest of the wait. On the form, with
 * details not yet filled or no fill at all, it fills now: the applicant
 * confirms what they see, and they have not seen this yet. With the form
 * filled and nothing new since, it presses Next, and the site lays the
 * application out for review. On the review page it asks for the captcha
 * again when none was typed, and counts down to Next when one was. Past
 * that it counts down to Next. Never a fill and Next in one word.
 */
function confirm(ctx, chatId) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  const failing = (what) => (error) =>
    log(chatId, `${what} failed: ${error.message}`);
  if (settleCountdown(chatId, 'go')) {
    log(chatId, 'confirmation received; skipping the rest of the countdown');
    return;
  }
  const stage = session.stage ?? 'form';
  if (stage === 'form') {
    if (formIsStale(session)) {
      log(chatId, 'confirmation received; filling now');
      fillNow(ctx, chatId).catch(failing('filling'));
      return;
    }
    log(chatId, 'confirmation received; sending the form for review');
    sendForm(ctx, chatId).catch(failing('the step to review'));
    return;
  }
  if (stage === 'review' && !session.captchaEntered) {
    log(chatId, 'confirmation received; the captcha is still needed');
    askCaptcha(ctx, chatId, strings.captchaAsk).catch(failing('the captcha'));
    return;
  }
  if (stage === 'declared') {
    // The application is in. What follows is Confirm and then payment,
    // which is the applicant's to do in the browser window: a card, a
    // charge, nothing to press on their behalf.
    log(chatId, 'confirmation received past registration; nothing pressed');
    ctx.reply(strings.inBrowserNow).catch(failing('the reply'));
    return;
  }
  log(chatId, `confirmation received at the ${stage} stage; counting down`);
  sendAfterCountdown(ctx, chatId).catch(failing('the step to Next'));
}

bot.command('fill', async (ctx) => {
  touch(ctx.chat.id);
  log(ctx.chat.id, '/fill');
  // Past the form there is nothing to fill: the page has moved on.
  if (await refuseIfPastForm(ctx, sessions.get(ctx.chat.id))) {
    return;
  }
  await fillNow(ctx, ctx.chat.id);
});

bot.command('reset', async (ctx) => {
  await store.forget(ctx.chat.id);
  await endChat(ctx.chat.id);
  await ctx.reply('Cleared. Send /start to begin again.');
});

bot.command('documents', async (ctx) => {
  const chatId = ctx.chat.id;
  touch(chatId);
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  // The application number is what the site looks an application up by, and
  // only the applicant has it: it arrives by email when the application is
  // filed.
  const asked = ctx.message.text.replace(/^\/documents\s*/, '').trim();
  const number =
    asked ||
    session.application?.applicationNumber ||
    store.read(chatId, 'applicationNumber');
  if (!number) {
    await ctx.reply(strings.documentsNeedNumber);
    return;
  }
  log(chatId, `/documents for ${shown(number)}`);
  await lookUpApplication(ctx, chatId, number);
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
  // A field the engines split on is not put on the form: the candidates
  // are kept, and the summary asks the applicant which is right.
  session.disputed = {};
  for (const { field, candidates } of read.disputed ?? []) {
    session.disputed[field] = candidates.map((c) => c.value);
    delete session.data[field];
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
  if (await refuseIfPastForm(ctx, session)) {
    return;
  }
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
  const kb = Math.round(buffer.length / 1024);
  log(chatId, `document received: ${extension}, ${kb} KB`);
  if (ctx.message.photo) {
    // Telegram shrinks a photo to a few kilobytes and strips what the
    // camera wrote; the site then doubts the portrait. Said each time, since
    // the fix is in how the next one is sent.
    log(chatId, 'sent as a photo, not a file; the chat is told');
    await ctx.reply(MESSAGES[session.language].sentAsPhoto(kb)).catch(() => {});
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
      if (read) {
        log(
          chatId,
          `prepared: ${read.prepared.cropped ? 'data page cut out' : 'kept whole'}, ${Math.round(read.prepared.bytes / 1024)} KB`
        );
        for (const note of read.notes ?? []) {
          log(chatId, `ocr: ${note}`);
        }
        for (const [field, info] of Object.entries(read.agreement ?? {})) {
          log(
            chatId,
            `${field}: ${info.votes} votes from ${info.sources.join(', ')}`
          );
        }
        for (const { field, candidates } of read.disputed ?? []) {
          log(
            chatId,
            `${field} disputed: ${candidates.map((c) => `"${shown(c.value)}" (${c.votes})`).join(' vs ')}`
          );
        }
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
      session.received = (session.received ?? 0) + 1;
    },
    // Kept while debugging, under the system temp directory. What eventually
    // removes them is the sweep below, which runs daily: a container's volume
    // survives restarts, so nothing else would.
    { keep: valuesAllowed() }
  ).finally(busy);

  armIdleFill(ctx, chatId);
}

/**
 * Details sent after the site took the form cannot reach it: the page has
 * moved on. The chat is told, and the countdown, if one runs, is stopped,
 * since a message with details in it is not a word to send.
 */
async function refuseIfPastForm(ctx, session) {
  if ((session.stage ?? 'form') === 'form') {
    return false;
  }
  settleCountdown(ctx.chat.id, 'stop');
  log(ctx.chat.id, 'details received past the form; refused');
  await ctx.reply(MESSAGES[session.language].pastForm);
  return true;
}

bot.on('message:text', (ctx) => inTurn(ctx.chat.id, () => receiveText(ctx)));

/**
 * Keeps the chat in the language its applicant reads.
 *
 * A language the applicant chose stays chosen. Reading it afresh from every
 * message turns a Russian chat to English on a captcha code, which is digits
 * and says nothing about the language its writer speaks.
 */
function followLanguage(ctx, session) {
  if (session.languageChosen) {
    return;
  }
  // A restart empties the sessions but not the store, so the first message
  // after one still answers in the language the applicant chose.
  const remembered = store.read(ctx.chat.id, 'language');
  if (remembered) {
    session.language = remembered;
    session.languageChosen = true;
    return;
  }
  session.language = detectLanguage(ctx.message.text, ctx.from?.language_code);
}

async function receiveText(ctx) {
  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);
  touch(chatId);
  followLanguage(ctx, session);
  if (isCancellation(ctx.message.text)) {
    await stopFilling(ctx, chatId);
    return;
  }
  if (isConfirmation(ctx.message.text)) {
    // "Подтверждаю", "отправляй", "go": runs on its own, so a "стой" sent
    // after it is still heard.
    confirm(ctx, chatId);
    return;
  }
  if (tookLookupCaptcha(ctx, chatId, session)) {
    return;
  }
  if (session.stage === 'review' && looksLikeCaptcha(ctx.message.text)) {
    // A code on the review page is the captcha's, asked for or not: one
    // sent during the countdown replaces the one typed, and the countdown
    // starts over on it.
    if (settleCountdown(chatId, 'stop')) {
      log(chatId, 'another captcha code received during the countdown');
    } else {
      log(chatId, 'captcha code received');
    }
    enterCaptcha(ctx, chatId, ctx.message.text).catch((error) =>
      log(chatId, `the captcha step failed: ${error.message}`)
    );
    return;
  }
  if (await refuseIfPastForm(ctx, session)) {
    return;
  }
  // New details end a countdown, since the form they go on is about to
  // change, and restart the quiet timer; the fill that follows puts only
  // what changed on the form, and explains only that.
  if (settleCountdown(chatId, 'stop')) {
    log(chatId, 'details received during the countdown; Next not pressed');
  }
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
  // A value the applicant types settles a field the passport's readers
  // split on.
  for (const key of Object.keys(parsed)) {
    delete session.disputed?.[key];
  }
  session.received = (session.received ?? 0) + 1;

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

/** True while the process is on its way out: a failure then goes unreported. */
let shuttingDown = false;

process.on('SIGINT', async () => {
  shuttingDown = true;
  // Each chat with a browser hears that it is closing, since the fill or
  // the page in it is lost with it; then browsers get a few seconds to
  // close, and one that hangs must not keep the process from exiting.
  const warned = [...browsers.keys()].map((chatId) => {
    const strings = MESSAGES[sessions.get(chatId).language];
    log(chatId, 'restarting; the chat is told its browser closes');
    return bot.api.sendMessage(chatId, strings.restarting).catch(() => {});
  });
  await Promise.race([
    Promise.all(warned),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
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
    // The commands Telegram offers in its own menu, so the three ways in are
    // visible without anybody being told them.
    await bot.api.setMyCommands([
      { command: 'start', description: 'start over, and choose a language' },
      { command: 'visa', description: 'apply for an e-visa' },
      { command: 'arrival', description: 'the pre-arrival declaration' },
      { command: 'documents', description: 'fetch a filed application' },
    ]);
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
