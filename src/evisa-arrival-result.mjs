#!/usr/bin/env node
// evisa-arrival-result.mjs
//
// Keeps the filed pre-arrival declaration before the site's short redirect
// returns the browser to its home page. The site downloads a valid PDF under
// a bare UUID, so the browser alone leaves the traveller with an opaque file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DECLARATION_PDF_NAME = 'Vietnam-Pre-Arrival-Declaration.pdf';
export const DECLARATION_QR_NAME = 'Vietnam-Pre-Arrival-QR.png';

const savedDownloads = new WeakMap();
const plannedNames = new WeakMap();

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

/** Saves even manually initiated Playwright downloads outside its temp tree. */
export function keepBrowserDownloads(page, directory, { log = () => {} } = {}) {
  if (!directory) {
    return;
  }
  fs.mkdirSync(directory, { recursive: true });
  page.on('download', (download) => {
    const wanted = plannedNames.get(page) ?? download.suggestedFilename();
    plannedNames.delete(page);
    saveDownload(download, directory, wanted)
      .then(({ file }) => log(`download saved as ${file}`))
      .catch((error) => log(`download could not be saved: ${error.message}`));
  });
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
  plannedNames.set(page, DECLARATION_PDF_NAME);
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout }),
      button.click({ timeout }),
    ]);
    return await saveDownload(download, directory, DECLARATION_PDF_NAME);
  } catch (error) {
    plannedNames.delete(page);
    throw error;
  }
}

/** Captures only the large result QR, excluding logos and step icons. */
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
      return false;
    }
    chosen.setAttribute('data-evisa-result-qr', 'true');
    return true;
  });
  if (!found) {
    throw new Error('the result page has no QR code image');
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

/** Sends success, PDF and QR as three independent Telegram messages. */
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
  await ctx.reply(strings.arrivalFiled).catch((error) => {
    log(chatId, `filing success message could not be sent: ${error.message}`);
  });
  if (result.pdf) {
    await ctx
      .replyWithDocument(new InputFile(result.pdf.file, DECLARATION_PDF_NAME), {
        caption: strings.arrivalResultPdf,
      })
      .catch((error) => {
        result.failures.push({ artifact: 'PDF', why: error.message });
        log(chatId, `result PDF could not be sent: ${error.message}`);
      });
  }
  if (result.qr) {
    await ctx
      .replyWithPhoto(new InputFile(result.qr, DECLARATION_QR_NAME), {
        caption: strings.arrivalResultQr,
      })
      .catch((error) => {
        result.failures.push({ artifact: 'QR code', why: error.message });
        log(chatId, `result QR code could not be sent: ${error.message}`);
      });
  }
  if (result.failures.length) {
    await ctx
      .reply(
        strings.arrivalResultIncomplete([
          ...new Set(result.failures.map(({ artifact }) => artifact)),
        ])
      )
      .catch(() => {});
  }
  if (result.temporary) {
    fs.rmSync(result.directory, { recursive: true, force: true });
  }
  return result;
}

function saveDownload(download, directory, preferredName) {
  if (savedDownloads.has(download)) {
    return savedDownloads.get(download);
  }
  const saving = (async () => {
    let name = safeFileName(preferredName || 'download');
    if (!path.extname(name)) {
      name += '.pdf';
    }
    const file = availableFile(directory, name);
    await download.saveAs(file);
    const bytes = fs.readFileSync(file);
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      fs.rmSync(file, { force: true });
      throw new Error('the downloaded file is not a PDF');
    }
    const original = await download.path().catch(() => null);
    if (original && path.resolve(original) !== path.resolve(file)) {
      fs.rmSync(original, { force: true });
    }
    return { file, bytes };
  })();
  savedDownloads.set(download, saving);
  return saving;
}

function safeFileName(value) {
  return [...String(value)]
    .map((character) => (character.charCodeAt(0) < 32 ? '-' : character))
    .join('')
    .replace(/[\\/:*?"<>|]/g, '-');
}

function availableFile(directory, name) {
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  let candidate = path.join(directory, name);
  for (let copy = 2; fs.existsSync(candidate); copy += 1) {
    candidate = path.join(directory, `${stem} (${copy})${extension}`);
  }
  return candidate;
}
