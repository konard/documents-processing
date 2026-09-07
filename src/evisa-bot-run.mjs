#!/usr/bin/env node
// evisa-bot-run.mjs
//
// Runs the Telegram bot defined in evisa-bot.mjs.
//
//   EVISA_BOT_TOKEN=<token from @BotFather> node src/evisa-bot-run.mjs
//
// The bot holds one browser per chat, opened on first contact and reused, so
// the applicant sees the same form growing as they send documents. It fills but
// never submits.

import fs from 'node:fs';
import path from 'node:path';
import {
  MESSAGES,
  IDLE_FILL_MS,
  detectLanguage,
  describeMissing,
  describeChecklist,
  parseFreeText,
  createSessionStore,
  withTempFile,
} from './evisa-bot.mjs';
import { normalizeApplicant } from './evisa-data.mjs';
import { readRequiredFields, outstandingFields } from './evisa-required.mjs';
import {
  FORM_URL,
  acceptNoteModal,
  waitForForm,
  fillForm,
} from './evisa-fill.mjs';

const token = process.env.EVISA_BOT_TOKEN;
if (!token) {
  console.error('Set EVISA_BOT_TOKEN to the token from @BotFather.');
  process.exit(1);
}

const { Bot, InputFile } = await import('grammy');
const { chromium } = await import('playwright');

const sessions = createSessionStore();
const browsers = new Map();
const timers = new Map();

/** Opens this chat's browser on the form, or returns the one already open. */
async function pageFor(chatId) {
  if (browsers.has(chatId)) {
    return browsers.get(chatId).page;
  }
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1000 },
  });
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
  await acceptNoteModal(page);
  await waitForForm(page);
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
  clearTimeout(timers.get(chatId));
  timers.delete(chatId);
}

/** Reads a passport page and returns whatever the MRZ gives up. */
async function readPassport(file) {
  const { readPassportMrz } = await import('./evisa-passport.mjs');
  const result = await readPassportMrz(file);
  if (!result.mrzFound) {
    return null;
  }
  const data = { ...result.data };
  // A field whose check digit failed is dropped: better to ask than to submit
  // a misread passport number.
  for (const field of result.unverified) {
    delete data[field];
  }
  return data;
}

/**
 * Captures the whole page, however tall.
 *
 * `fullPage` grows the screenshot past the window, which is what the applicant
 * needs: the form is several screens long and the interesting part is often the
 * validation message at the bottom.
 */
async function screenshotPage(page, chatId) {
  const dir = fs.mkdtempSync(path.join('/tmp', `evisa-shot-${chatId}-`));
  const file = path.join(dir, 'form.png');
  await page.screenshot({ path: file, fullPage: true });
  return { file, dir };
}

/** Fills the form with what the chat has provided and sends back the page. */
async function fillAndShow(ctx, chatId) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  const page = await pageFor(chatId);

  await ctx.reply(strings.filling);
  const applicant = normalizeApplicant(session.data);
  const result = await fillForm(page, applicant, { uploads: session.uploads });

  const { file, dir } = await screenshotPage(page, chatId);
  try {
    await ctx.replyWithPhoto(new InputFile(file), {
      caption: strings.filled(result.filled.length),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  for (const failure of result.failures.slice(0, 5)) {
    await ctx.reply(
      strings.failed(failure.field, failure.error.split('\n')[0])
    );
  }

  // Ask the page itself what is still required, so a change on their side
  // surfaces as a question to the applicant.
  const report = await readRequiredFields(page);
  const outstanding = outstandingFields(report, session.data);
  if (outstanding.length) {
    await ctx.reply(describeMissing(outstanding, session.language));
  } else {
    await ctx.reply(strings.ready);
  }
}

/** Restarts the quiet timer that fills the form when the applicant pauses. */
function armIdleFill(ctx, chatId) {
  clearTimeout(timers.get(chatId));
  timers.set(
    chatId,
    setTimeout(() => {
      fillAndShow(ctx, chatId).catch((error) =>
        ctx.reply(`Could not fill the form: ${error.message}`).catch(() => {})
      );
    }, IDLE_FILL_MS)
  );
}

const bot = new Bot(token);

bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  await endChat(chatId);
  const session = sessions.get(chatId);
  session.language = detectLanguage(null, ctx.from?.language_code);
  const strings = MESSAGES[session.language];

  await ctx.reply(strings.welcome);
  // List everything up front, read from the live form.
  const page = await pageFor(chatId);
  const report = await readRequiredFields(page);
  await ctx.reply(describeChecklist(report.required, session.language));
  armIdleFill(ctx, chatId);
});

bot.command('fill', async (ctx) => {
  await fillAndShow(ctx, ctx.chat.id);
});

bot.command('reset', async (ctx) => {
  await endChat(ctx.chat.id);
  await ctx.reply('Cleared. Send /start to begin again.');
});

bot.on(['message:photo', 'message:document'], async (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  await ctx.reply(strings.reading);

  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const buffer = Buffer.from(await (await fetch(url)).arrayBuffer());
  const extension = path.extname(file.file_path || '.jpg') || '.jpg';

  await withTempFile(buffer, extension, async (local) => {
    // A photo of a whole passport carries background the form does not want, so
    // the data page is cut out first. An image that is already just the page is
    // left alone.
    const { cropPassportPage } = await import('./evisa-passport.mjs');
    const cropped = `${local}.page.jpg`;
    const crop = await cropPassportPage(local, cropped).catch(() => null);
    const source = crop?.cropped ? cropped : local;

    const read = await readPassport(source).catch(() => null);
    if (read && Object.keys(read).length) {
      Object.assign(session.data, read);
      // Keep the page for upload; it is copied because the temp file goes away.
      const kept = path.join(
        fs.mkdtempSync(path.join('/tmp', 'evisa-doc-')),
        `passport${extension}`
      );
      fs.copyFileSync(source, kept);
      session.uploads.passportPage = kept;
    } else {
      // Not a passport: treat it as the portrait, which is the other image the
      // form wants and needs no reading.
      const kept = path.join(
        fs.mkdtempSync(path.join('/tmp', 'evisa-doc-')),
        `portrait${extension}`
      );
      fs.copyFileSync(local, kept);
      session.uploads.portraitPhoto = kept;
    }
  });

  armIdleFill(ctx, chatId);
});

bot.on('message:text', (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);
  session.language = detectLanguage(ctx.message.text, ctx.from?.language_code);
  Object.assign(session.data, parseFreeText(ctx.message.text));
  armIdleFill(ctx, chatId);
});

process.on('SIGINT', async () => {
  for (const chatId of [...browsers.keys()]) {
    await endChat(chatId);
  }
  process.exit(0);
});

console.log('e-visa bot running. Press Ctrl+C to stop.');
bot.start();
