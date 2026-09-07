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
import { openForm, prepareDocument, fillAndCapture } from './evisa-session.mjs';

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

/** Opens this chat's browser on the form, or returns the one already open. */
async function pageFor(chatId) {
  if (browsers.has(chatId)) {
    return browsers.get(chatId).page;
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

/** Fills the form with what the chat has provided and sends back the page. */
async function fillAndShow(ctx, chatId) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  const page = await pageFor(chatId);

  await ctx.reply(strings.filling);
  const applicant = normalizeApplicant(session.data);
  log(chatId, `filling with: ${describeFields(applicant)}`);
  // Show what will go on the form, before showing the form itself.
  const summary = describeSummary(applicant, session.data, session.language);
  if (summary) {
    await ctx.reply(summary);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `evisa-shot-${chatId}-`));
  const result = await fillAndCapture(page, applicant, {
    uploads: session.uploads,
    screenshot: path.join(dir, 'form.png'),
  });

  try {
    await ctx.replyWithPhoto(new InputFile(result.screenshot), {
      caption: strings.filled(result.filled.length),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  log(
    chatId,
    `filled ${result.filled.length}, failed ${result.failures.length}` +
      `, site agreed on ${result.agreed?.length ?? 0}` +
      `, corrected ${result.corrected?.length ?? 0}`
  );
  for (const failure of result.failures) {
    log(
      chatId,
      `could not fill ${failure.field}: ${failure.error.split('\n')[0]}`
    );
  }
  for (const change of result.corrected ?? []) {
    log(chatId, `corrected ${change.field}: site had "${change.was}"`);
  }

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
  log(chatId, `/start from language_code=${ctx.from?.language_code ?? '?'}`);
  await endChat(chatId);
  const session = sessions.get(chatId);
  session.language = detectLanguage(null, ctx.from?.language_code);

  // The checklist is read from the live form and sent as one message.
  const page = await pageFor(chatId);
  const report = await readRequiredFields(page);
  await ctx.reply(describeChecklist(report.required, session.language));
  // No timer yet: filling an empty form would tell the applicant nothing.
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
      // A photo of a whole passport carries background the form has no use for,
      // so the data page is cut out first.
      const prepared = `${local}.upload.jpg`;
      const ready = await prepareDocument(local, prepared, {
        crop: true,
      }).catch((error) => {
        log(chatId, `preparing the document failed: ${error.message}`);
        return null;
      });
      const source = ready ? prepared : local;
      if (ready) {
        log(
          chatId,
          `prepared: ${ready.cropped ? 'data page cut out' : 'kept whole'}, ${Math.round(ready.bytes / 1024)} KB`
        );
      }

      const read = await readPassport(source).catch((error) => {
        log(chatId, `reading the passport failed: ${error.message}`);
        return null;
      });
      log(chatId, `read from the document: ${describeFields(read ?? {})}`);
      if (read && Object.keys(read).length) {
        Object.assign(session.data, read);
        session.uploads.passportPage = keepForUpload(
          source,
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
  );

  armIdleFill(ctx, chatId);
});

bot.on('message:text', (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);
  session.language = detectLanguage(ctx.message.text, ctx.from?.language_code);
  const parsed = parseFreeText(ctx.message.text);
  log(
    chatId,
    `text message (${session.language}); read: ${describeFields(parsed)}`
  );
  Object.assign(session.data, parsed);
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
bot.start();
