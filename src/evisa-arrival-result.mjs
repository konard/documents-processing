#!/usr/bin/env node
// evisa-arrival-result.mjs
//
// Keeps the filed pre-arrival declaration before the site's short redirect
// returns the browser to its home page. The site downloads a valid PDF under
// a bare UUID, so the browser alone leaves the traveller with an opaque file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkpointBrowser,
  ensureManagedDownloads,
} from './evisa-browser-features.mjs';

export const DECLARATION_PDF_NAME = 'Vietnam-Pre-Arrival-Declaration.pdf';
export const DECLARATION_QR_NAME = 'Vietnam-Pre-Arrival-QR.png';

/** Reads the site's terminal result without treating every step 4 as success. */
export async function readDeclarationResult(page) {
  const text = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  const duplicate =
    /Duplicate pre-arrival information for traveller Passport Number\s+([^\s]+)/i.exec(
      text
    );
  if (duplicate) {
    return { status: 'duplicate', passportNumber: duplicate[1] };
  }
  if (/Your submission is successful!/i.test(text)) {
    return { status: 'successful', passportNumber: null };
  }
  return { status: 'unknown', passportNumber: null };
}

/** The persistent download folder used by the visible bot browser. */
export function configuredDownloadsDirectory(
  env = process.env,
  { home = os.homedir(), resolve = path.resolve } = {}
) {
  const configured = String(env.EVISA_BOT_DOWNLOADS_DIR ?? '').trim();
  if (/^(temporary|temp|off)$/i.test(configured)) {
    return null;
  }
  if (!configured) {
    return path.join(home, 'Downloads');
  }
  if (configured === '~') {
    return home;
  }
  if (configured.startsWith('~/')) {
    return path.join(home, configured.slice(2));
  }
  return resolve(configured);
}

/** Clicks the result-page PDF button and returns its validated, named file. */
export async function downloadDeclarationPdf(
  page,
  directory,
  { timeout = 20000 } = {}
) {
  const button = page
    .getByRole('button', { name: /Download PDF Pre-Arrival Information/i })
    .first();
  await button.waitFor({ state: 'visible', timeout });
  const downloads = await ensureManagedDownloads(page, directory);
  const artifact = await downloads.capture({
    action: () => button.click({ timeout }),
    filename: DECLARATION_PDF_NAME,
    timeout,
    validate: ({ path: candidate }) => {
      const file = fs.openSync(candidate, 'r');
      try {
        const head = Buffer.alloc(5);
        fs.readSync(file, head, 0, head.length, 0);
        return head.equals(Buffer.from('%PDF-'));
      } finally {
        fs.closeSync(file);
      }
    },
  });
  return { file: artifact.path, bytes: fs.readFileSync(artifact.path) };
}

/** Extracts the original result QR, excluding its decorative browser card. */
export async function captureDeclarationQr(page) {
  const found = await page.evaluate(() => {
    // This callback runs in the browser, where document is the page under test.
    // eslint-disable-next-line no-undef
    const candidates = [...document.querySelectorAll('img, canvas, svg')]
      .map((element) => {
        const box = element.getBoundingClientRect();
        if (
          box.width < 120 ||
          box.height < 120 ||
          box.width / box.height < 0.75 ||
          box.width / box.height > 1.33
        ) {
          return null;
        }
        let around = element;
        let words = '';
        for (let level = 0; level < 5 && around; level += 1) {
          words += ` ${around.innerText ?? ''}`;
          around = around.parentElement;
        }
        const attributes = `${element.getAttribute('alt') ?? ''} ${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('src') ?? ''}`;
        const score =
          (/qr/i.test(attributes) ? 10 : 0) +
          (/QR code|look up your declaration/i.test(words) ? 20 : 0) +
          Math.min(box.width, box.height) / 100;
        return { element, score };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score);
    const chosen = candidates[0]?.element;
    if (!chosen) {
      return null;
    }
    const tag = chosen.tagName.toLowerCase();
    if (tag === 'img') {
      const source = chosen.getAttribute('src') ?? '';
      if (/^data:image\/png;base64,/i.test(source)) {
        return { dataUrl: source };
      }
    }
    if (tag === 'canvas') {
      return { dataUrl: chosen.toDataURL('image/png') };
    }
    chosen.setAttribute('data-evisa-result-qr', 'true');
    return { screenshot: true };
  });
  if (!found) {
    throw new Error('the result page has no QR code image');
  }
  if (found.dataUrl) {
    const encoded = /^data:image\/png;base64,(.+)$/is.exec(found.dataUrl)?.[1];
    if (!encoded) {
      throw new Error('the result QR code is not a readable PNG');
    }
    return Buffer.from(encoded, 'base64');
  }
  return page.locator('[data-evisa-result-qr="true"]').screenshot({
    type: 'png',
  });
}

/** Logs the complete result markup, then gathers both downloadable artifacts. */
export async function collectDeclarationResult({
  page,
  chatId,
  downloadsDirectory,
  keepMarkup = async () => {},
  log = () => {},
}) {
  await checkpointBrowser(page, 'prearrival-result', {
    actor: 'site',
    reason: 'result',
  });
  await keepMarkup(chatId, page, 'arrival-result');
  const temporary = !downloadsDirectory;
  const directory =
    downloadsDirectory ??
    fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-result-'));
  fs.mkdirSync(directory, { recursive: true });
  const result = { pdf: null, qr: null, failures: [], temporary, directory };

  try {
    result.qr = await captureDeclarationQr(page);
    log('result QR code captured');
  } catch (error) {
    result.failures.push({ artifact: 'QR code', why: error.message });
    log(`result QR code could not be captured: ${error.message}`);
  }
  try {
    result.pdf = await downloadDeclarationPdf(page, directory);
    log(`result PDF saved as ${result.pdf.file}`);
  } catch (error) {
    result.failures.push({ artifact: 'PDF', why: error.message });
    log(`result PDF could not be downloaded: ${error.message}`);
  }
  return result;
}

/** Sends success on an artifact, keeping PDF and QR independently usable. */
export async function sendDeclarationResult({
  ctx,
  chatId,
  page,
  strings,
  InputFile,
  downloadsDirectory,
  keepMarkup,
  log = () => {},
}) {
  const result = await collectDeclarationResult({
    page,
    chatId,
    downloadsDirectory,
    keepMarkup,
    log: (said) => log(chatId, said),
  });
  let announced = false;
  if (result.pdf) {
    try {
      await ctx.replyWithDocument(
        new InputFile(result.pdf.file, DECLARATION_PDF_NAME),
        { caption: `${strings.arrivalFiled}\n\n${strings.arrivalResultPdf}` }
      );
      announced = true;
    } catch (error) {
      result.failures.push({ artifact: 'PDF', why: error.message });
      log(chatId, `result PDF could not be sent: ${error.message}`);
    }
  }
  if (result.qr) {
    try {
      const caption = announced
        ? strings.arrivalResultQr
        : `${strings.arrivalFiled}\n\n${strings.arrivalResultQr}`;
      await ctx.replyWithPhoto(new InputFile(result.qr, DECLARATION_QR_NAME), {
        caption,
      });
      announced = true;
    } catch (error) {
      result.failures.push({ artifact: 'QR code', why: error.message });
      log(chatId, `result QR code could not be sent: ${error.message}`);
    }
  }
  if (result.failures.length) {
    await ctx
      .reply(
        strings.arrivalResultIncomplete([
          ...new Set(result.failures.map(({ artifact }) => artifact)),
        ])
      )
      .catch(() => {});
  } else if (!announced) {
    await ctx.reply(strings.arrivalFiled).catch((error) => {
      log(chatId, `filing success message could not be sent: ${error.message}`);
    });
  }
  if (result.temporary) {
    fs.rmSync(result.directory, { recursive: true, force: true });
  }
  return result;
}

/** Logs and shows a duplicate terminal result without looking for artifacts. */
export async function sendDuplicateDeclarationResult({
  ctx,
  chatId,
  page,
  strings,
  passportNumber,
  InputFile,
  keepMarkup,
  log = () => {},
}) {
  await checkpointBrowser(page, 'prearrival-duplicate', {
    actor: 'site',
    reason: 'duplicate',
  });
  await keepMarkup(chatId, page, 'arrival-result-duplicate');
  const caption = strings.arrivalDuplicate(passportNumber);
  try {
    const screenshot = await page.screenshot({ fullPage: true });
    await ctx.replyWithPhoto(
      new InputFile(screenshot, 'Vietnam-Pre-Arrival-Duplicate.png'),
      { caption }
    );
    log(chatId, 'duplicate result screenshot sent');
  } catch (error) {
    log(
      chatId,
      `duplicate result screenshot could not be sent: ${error.message}`
    );
    await ctx.reply(caption).catch(() => {});
  }
}
