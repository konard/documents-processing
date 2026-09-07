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
  readFilledFields,
} from './evisa-fill.mjs';
import { FIELDS } from './evisa-schema.mjs';

/**
 * Opens a browser on the application form, past the dialog that gates it.
 *
 * `headless` is the only thing the two callers differ on: the command-line tool
 * hands the window to the applicant, the bot never shows one.
 */
export async function openForm({ headless = false, viewport } = {}) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless,
    // Start the window large enough to show the form without scrolling
    // horizontally; the page itself then follows whatever size the window is.
    args: headless ? [] : ['--window-size=1500,1000'],
  });
  // A visible window gets no fixed viewport, so resizing it resizes the page.
  // Pinning one would leave the layout stuck at its original size, which is
  // what made the window unresponsive to being dragged wider.
  // A headless page is only ever seen through its capture, so it is rendered
  // at twice the pixel density: text on a page nine screens tall has to stay
  // legible when the applicant zooms into the file.
  const page = await browser.newPage({
    viewport: headless ? (viewport ?? { width: 1500, height: 1000 }) : null,
    deviceScaleFactor: headless ? 2 : undefined,
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
 * Waits for the page to stop changing.
 *
 * Angular re-renders after each value, the site validates fields over the
 * network, and a dropdown may still be closing. A capture taken while any of
 * that is in flight shows a form mid-fill. The sign that it has finished is
 * two readings of the page, a moment apart, that agree.
 */
export async function settleForm(page, { timeout = 15000 } = {}) {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
  await page
    .waitForFunction(
      () =>
        !document.querySelector(
          '.ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-spin-spinning'
        ),
      undefined,
      { timeout }
    )
    .catch(() => {});

  const snapshot = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll('input, textarea')]
          .map((element) => element.value)
          .join('') + document.body.scrollHeight
    );
  let previous = await snapshot();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const current = await snapshot();
    if (current === previous) {
      return;
    }
    previous = current;
  }
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
  await settleForm(page);
  await page.screenshot({ path: outputPath, fullPage: true });
  return outputPath;
}

/**
 * Fields that were set and now show nothing.
 *
 * Angular rebuilds a control now and then after its value was written, and
 * the value goes with it. Reading the page back is the only way to know.
 */
async function emptiedFields(page, applicant, filled) {
  const shown = await readFilledFields(page);
  return filled.filter((key) => FIELDS[key] && applicant[key] && !shown[key]);
}

/**
 * Fills the form and captures the result, which is what both front ends call
 * with whatever data they hold.
 *
 * The capture waits for the page to settle and for every value to be on it,
 * so what the applicant is shown is the finished form.
 */
export async function fillAndCapture(page, applicant, { uploads, screenshot }) {
  const result = await fillForm(page, applicant, { uploads });
  await settleForm(page);

  const emptied = await emptiedFields(page, applicant, result.filled);
  if (emptied.length) {
    const again = await fillForm(
      page,
      Object.fromEntries(emptied.map((key) => [key, applicant[key]]))
    );
    result.failures.push(...again.failures);
    await settleForm(page);
  }

  const image = screenshot ? await captureForm(page, screenshot) : null;
  return { ...result, refilled: emptied, screenshot: image };
}
