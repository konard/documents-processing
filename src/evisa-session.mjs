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
  tickDeclarations,
  pressButton,
  readDialog,
} from './evisa-fill.mjs';
import { FIELDS } from './evisa-schema.mjs';

/**
 * Opens a browser on the application form, past the dialog that gates it.
 *
 * `headless` is the only thing the two callers differ on: the command-line tool
 * hands the window to the applicant, the bot never shows one.
 */
export async function openForm({
  headless = false,
  viewport,
  debugPort = 0,
} = {}) {
  const { chromium } = await import('playwright');
  // A window that takes the screen the moment it opens interrupts whatever
  // the applicant was doing, and the form is not worth looking at until it is
  // filled. It opens behind, and `bringToFront` raises it when it is ready.
  const args = headless
    ? []
    : ['--window-size=1500,1000', '--no-startup-window-activation'];
  if (debugPort) {
    // A debugger, chrome://inspect or a second Playwright, can then attach
    // to this browser and see what it sees.
    args.push(`--remote-debugging-port=${debugPort}`);
  }
  const browser = await chromium.launch({
    headless,
    // Start the window large enough to show the form without scrolling
    // horizontally; the page itself then follows whatever size the window is.
    args,
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
  const { cropPassportPage, prepareUploadImage, readPassportMrz } =
    await import('./evisa-passport.mjs');

  let source = inputPath;
  let cropped = false;
  let temporary = null;
  let mrz = null;

  if (crop) {
    const candidate = `${outputPath}.page.jpg`;
    const result = await cropPassportPage(inputPath, candidate).catch(
      () => null
    );
    // The zone is read off the photo as sent either way; a caller wanting the
    // passport's fields gets them without a second reading.
    const before = await readPassportMrz(inputPath).catch(() => null);
    mrz = before;
    if (result?.cropped) {
      // A crop is only kept when the page still reads afterwards. Geometry
      // alone cannot tell a clean cut from one that took a corner off, so the
      // proof is that the machine-readable zone survives.
      const after = await readPassportMrz(candidate).catch(() => null);
      const keptWhatItHad =
        after?.mrzFound &&
        (!before?.mrzFound ||
          after.data.passportNumber === before.data.passportNumber);

      if (keptWhatItHad) {
        source = candidate;
        cropped = true;
        temporary = candidate;
        mrz = betterMrzRead(before, after);
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
  return { ...prepared, cropped, mrz };
}

/**
 * The cleaner of two readings of the same zone: the one with more of its
 * check digits holding, then the one with more fields. The photo as sent and
 * the page cut out of it read differently, and neither is always better.
 */
function betterMrzRead(a, b) {
  if (!a?.mrzFound) {
    return b;
  }
  if (!b?.mrzFound) {
    return a;
  }
  const trouble = (read) => read.unverified.length + read.repaired.length;
  if (trouble(a) !== trouble(b)) {
    return trouble(a) < trouble(b) ? a : b;
  }
  return Object.keys(b.data).length > Object.keys(a.data).length ? b : a;
}

/**
 * Reads everything a passport photo gives: the page is cut out and made
 * ready for upload, the machine-readable zone is read, and the printed side
 * supplies the fields the zone leaves out.
 *
 * Returns `{ prepared, data, unverified }`: the upload's path and how it
 * was prepared, the fields read, and the fields whose check digit failed.
 * A photo with no zone in it gives no data, and is a portrait or something
 * else.
 */
export async function readPassportDocument(inputPath, outputPath) {
  const prepared = await prepareDocument(inputPath, outputPath, {
    crop: true,
  });
  // Every engine at hand reads the page, cut out when it could be, and each
  // field is what they agree on; the notes say who read what.
  const { readPassportConsensus } =
    await import('./evisa-passport-consensus.mjs');
  const notes = [];
  const read = await readPassportConsensus(prepared.path, {
    log: (line) => notes.push(line),
  });
  if (!read.data.passportNumber && !prepared.mrz?.mrzFound) {
    return { prepared, data: {}, unverified: [], disputed: [], notes };
  }
  const data = { ...read.data };
  // A number or a date no check digit stood behind is dropped: better to
  // ask than to put a misread passport number on the form.
  for (const field of read.unverified) {
    delete data[field];
  }
  return {
    prepared,
    data,
    unverified: read.unverified,
    disputed: read.disputed,
    agreement: read.agreement,
    weak: read.weak,
    notes,
  };
}

/**
 * The same, run on a worker thread.
 *
 * Reading a page takes the OCR engine ten seconds or more, and it runs
 * synchronously. On the main thread that would stall every other chat and
 * the status the bot shows while it works.
 */
export async function readPassportDocumentInWorker(inputPath, outputPath) {
  const { Worker } = await import('node:worker_threads');
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./evisa-passport-worker.mjs', import.meta.url),
      { workerData: { inputPath, outputPath } }
    );
    let answered = false;
    worker.once('message', (message) => {
      answered = true;
      if (message.ok) {
        resolve(message.result);
      } else {
        reject(new Error(message.error));
      }
    });
    worker.once('error', reject);
    // A worker that ends without answering, whatever its exit code, must not
    // leave the caller waiting for ever.
    worker.once('exit', (code) => {
      if (!answered) {
        reject(new Error(`passport reader exited with code ${code}`));
      }
    });
  });
}

/** Brings an open page back to an empty form, past the dialog again. */
export async function reopenForm(page) {
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
  await acceptNoteModal(page);
  await waitForForm(page);
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
  // The uploaded portrait and passport page are drawn from data the site
  // fetches back, and a capture taken before they arrive shows empty frames
  // where the applicant is checking their own pictures.
  await page
    .waitForFunction(
      () =>
        [...document.images].every(
          (image) => image.complete && image.naturalWidth > 0
        ),
      undefined,
      { timeout }
    )
    .catch(() => {});
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
  // A field the form is still checking is drawn with a red border until the
  // check comes back. Capturing then shows the applicant an error against a
  // value the site went on to accept, so the checks are waited out.
  await page
    .waitForFunction(
      () =>
        !document.querySelector(
          '.ant-form-item-is-validating, .ant-select-open'
        ),
      undefined,
      { timeout }
    )
    .catch(() => {});

  const snapshot = () =>
    page.evaluate(
      () =>
        // The errors showing count as part of the page: one that is about to
        // clear means the page has not settled.
        [...document.querySelectorAll('.ant-form-item-has-error')].length +
        [...document.querySelectorAll('input, textarea')]
          .map((element) => element.value)
          .join('') +
        document.body.scrollHeight
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
  // A header that sticks to the top of the window is drawn again at every
  // scroll position of a full-page capture, so the site's navigation landed
  // in the middle of the occupation section. Held still for the capture and
  // released after it.
  const released = await holdStillForCapture(page);
  // A dialog locks the page's scrolling, and a capture of the whole page
  // under it comes out as the dialog over a screen of content and a long
  // blank tail. The dialog is what there is to see, and it fits a screen.
  const fullPage = !(await readDialog(page));
  try {
    await page.screenshot({ path: outputPath, fullPage });
  } finally {
    await released();
  }
  return outputPath;
}

/**
 * Stops anything from following the window while the page is captured.
 *
 * Returns what puts it back, so the applicant's own browser is left as it
 * was: they are looking at this page too.
 */
async function holdStillForCapture(page) {
  const marker = 'evisa-hold-still';
  await page
    .addStyleTag({
      content: `
        [class*="sticky"], [class*="fixed"], header, nav {
          position: static !important;
        }
      `,
      // Named, so exactly this rule is the one taken away again.
      id: marker,
    })
    .catch(() => {});
  return async () => {
    await page
      .evaluate((id) => document.getElementById(id)?.remove(), marker)
      .catch(() => {});
  };
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
 * The declarations under the form are ticked with the first fill, so the
 * form the applicant sees is the one that Next accepts; which were ticked is
 * reported, since each is a statement made in their name. The capture waits
 * for the page to settle and for every value to be on it, so what the
 * applicant is shown is the finished form.
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
  const declared = await tickDeclarations(page);

  const image = screenshot ? await captureForm(page, screenshot) : null;
  return { ...result, refilled: emptied, declared, screenshot: image };
}

/**
 * Presses a button, Next unless another label is given, and captures
 * whatever page that leads to: the next stage when the site accepted the
 * page, or the same page with the site's messages when it did not.
 */
export async function advanceAndCapture(page, screenshot, label = 'Next') {
  const step = await pressButton(page, label);
  // The stage the step bar names is drawn a moment later; what is captured
  // and asked of the page afterwards must be the drawn stage.
  await settleForm(page);
  // The review page is drawn from data the site fetches, and now and then
  // that fails and the page stays bare: a step bar over nothing. Its
  // captcha is the sign that it drew.
  const empty =
    step.stage === 'review' &&
    !(await page
      .waitForSelector('#basic_captcha', { timeout: 15000 })
      .catch(() => null));
  const image = screenshot ? await captureForm(page, screenshot) : null;
  return { ...step, empty, screenshot: image };
}

/**
 * Raises the browser window.
 *
 * The window opens behind whatever the applicant is doing, and comes forward
 * when the form is filled.
 */
export async function showBrowser(page) {
  await page.bringToFront().catch(() => {});
}

/**
 * Captures one part of the form, by its heading.
 *
 * The part is measured on the page and cut from a capture of it, so what the
 * applicant is sent is exactly the part just filled, with the site's
 * navigation held still and its banner left off.
 */
export async function captureSection(page, title, outputPath) {
  const released = await holdStillForCapture(page);
  try {
    const box = await page.evaluate((wanted) => {
      const headings = [...document.querySelectorAll('h3')].filter(
        (heading) => heading.offsetParent !== null
      );
      const at = headings.findIndex(
        (heading) => heading.innerText.trim() === wanted
      );
      if (at < 0) {
        return null;
      }
      const top = headings[at].getBoundingClientRect().top + window.scrollY;
      const next = headings[at + 1];
      const bottom = next
        ? next.getBoundingClientRect().top + window.scrollY
        : document.documentElement.scrollHeight;
      return { top: Math.max(0, top - 16), bottom };
    }, title);
    if (!box) {
      return null;
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    // A part below the fold lies outside the window, so the clip is measured
    // against the whole page.
    await page.screenshot({
      path: outputPath,
      fullPage: true,
      clip: {
        x: 0,
        y: box.top,
        width: page.viewportSize()?.width ?? 1500,
        height: Math.max(1, box.bottom - box.top),
      },
    });
    return outputPath;
  } finally {
    await released();
  }
}

/**
 * Fills the form one part at a time, in the order the form prints them.
 *
 * The applicant reads the form downwards, so it is filled downwards. Each
 * part is filled, settled and handed to `onSection` before the next is begun,
 * so the chat shows the form appearing in the order it is actually filled —
 * and a part with nothing to fill is still shown, since the applicant is
 * checking it either way.
 *
 * The uploads go first, being the pictures at the top of the form, and the
 * declarations are ticked at the end, under the last part.
 */
export async function fillBySection(
  page,
  applicant,
  { uploads, onSection, capture }
) {
  const { FIELDS } = await import('./evisa-schema.mjs');
  const { readFieldSections, groupBySection, SECTION_ORDER } =
    await import('./evisa-sections.mjs');
  // The page is asked where its fields are, so a form that has been
  // rearranged is still filled in its own order.
  const placement = await readFieldSections(page, FIELDS);
  const parts = groupBySection(applicant, placement);

  const result = { filled: [], typed: [], failures: [], sections: [] };
  const take = (from) => {
    result.filled.push(...from.filled);
    result.typed.push(...from.typed);
    result.failures.push(...from.failures);
  };

  if (uploads && Object.keys(uploads).length) {
    take(await fillForm(page, {}, { uploads }));
    await settleForm(page);
    await report(0, SECTION_ORDER[0], result, onSection, capture);
  }

  // Every part of the form is shown, in printed order, whether or not this
  // fill had anything to put in it: the applicant is checking all of them,
  // and a part that skipped its turn reads as one that went wrong.
  const filling = new Map(parts.map((part) => [part.at, part]));
  const shown = await presentSections(page);
  for (const { at, title } of shown) {
    const part = filling.get(at);
    if (part) {
      take(await fillForm(page, part.fields));
      // Only a part that was written to needs settling; one merely being
      // shown is already as settled as the part before it left it.
      await settleForm(page, { timeout: 8000 });
    }
    await report(at, title, result, onSection, capture);
  }
  // Anything the page had no place for is attempted last, so nothing is
  // silently dropped for want of a heading to sit under.
  for (const part of parts) {
    if (!shown.some(({ at }) => at === part.at)) {
      take(await fillForm(page, part.fields));
      await settleForm(page);
    }
  }

  result.declared = await tickDeclarations(page);
  return result;
}

/**
 * The parts the form is showing, in printed order.
 *
 * Read from the page, so a form that has grown a part is still shown whole.
 */
async function presentSections(page) {
  const { sectionNumber } = await import('./evisa-sections.mjs');
  const titles = await page
    .evaluate(() =>
      [...document.querySelectorAll('h3')]
        .filter((heading) => heading.offsetParent !== null)
        .map((heading) => heading.innerText.trim())
    )
    .catch(() => []);
  return titles.map((title, order) => ({
    at: sectionNumber(title) ?? order,
    title,
  }));
}

/** Captures one part of the form and hands it over, if a caller wants it. */
async function report(at, title, result, onSection, capture) {
  if (!onSection) {
    return;
  }
  const image = capture ? await capture(at, title) : null;
  result.sections.push({ at, title });
  await onSection({ at, title, image }).catch(() => {});
}
