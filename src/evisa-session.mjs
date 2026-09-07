// evisa-session.mjs
//
// The steps the command-line tool and the Telegram bot both need: opening the
// form, preparing a document for upload, and capturing the filled page.
//
// Keeping them here means the two front ends behave identically. A fix to the
// modal handling or the crop reaches both, and neither can drift into its own
// slightly different version of the same sequence.

import fs from 'node:fs';
import path from 'node:path';
import {
  FORM_URL,
  acceptNoteModal,
  waitForForm,
  fillForm,
} from './evisa-fill.mjs';

/**
 * Opens a browser on the application form, past the dialog that gates it.
 *
 * `headless` is the only thing the two callers differ on: the command-line tool
 * hands the window to the applicant, the bot never shows one.
 */
export async function openForm({ headless = false, viewport } = {}) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage({
    viewport: viewport ?? { width: 1500, height: 1000 },
  });
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
  await acceptNoteModal(page);
  await waitForForm(page);
  return { browser, page };
}

/**
 * Prepares a document for upload: the data page is cut out of a wider photo,
 * then the image is brought within the form's limits.
 *
 * Returns the path to use and what was done to get there, so a caller can tell
 * the applicant whether their image was altered.
 */
export async function prepareDocument(
  inputPath,
  outputPath,
  { crop = false } = {}
) {
  const { cropPassportPage, prepareUploadImage } =
    await import('./evisa-passport.mjs');

  let source = inputPath;
  let cropped = false;
  let temporary = null;

  if (crop) {
    const candidate = `${outputPath}.page.jpg`;
    const result = await cropPassportPage(inputPath, candidate).catch(
      () => null
    );
    if (result?.cropped) {
      // A crop is only kept when the page still reads afterwards. Geometry
      // alone cannot tell a clean cut from one that took a corner off, so the
      // proof is that the machine-readable zone survives.
      const { readPassportMrz } = await import('./evisa-passport.mjs');
      const before = await readPassportMrz(inputPath).catch(() => null);
      const after = await readPassportMrz(candidate).catch(() => null);
      const keptWhatItHad =
        after?.mrzFound &&
        (!before?.mrzFound ||
          after.data.passportNumber === before.data.passportNumber);

      if (keptWhatItHad) {
        source = candidate;
        cropped = true;
        temporary = candidate;
      } else {
        fs.rmSync(candidate, { force: true });
      }
    } else if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { force: true });
    }
  }

  const prepared = await prepareUploadImage(source, outputPath);
  if (temporary && temporary !== outputPath) {
    fs.rmSync(temporary, { force: true });
  }
  return { ...prepared, cropped };
}

/**
 * Captures the whole page, however far it scrolls.
 *
 * The form runs to several screens and the part worth seeing is often the
 * validation message at the bottom, which a window-sized capture would cut
 * off.
 */
export async function captureForm(page, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await page.screenshot({ path: outputPath, fullPage: true });
  return outputPath;
}

/**
 * Fills the form and captures the result, which is what both front ends call
 * with whatever data they hold.
 */
export async function fillAndCapture(page, applicant, { uploads, screenshot }) {
  const result = await fillForm(page, applicant, { uploads });
  const image = screenshot ? await captureForm(page, screenshot) : null;
  return { ...result, screenshot: image };
}
