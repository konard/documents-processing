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
import {
  giveBackTheFront,
  takeTheFrontBack,
  whatIsInFront,
} from './evisa-window.mjs';

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
  blank = false,
} = {}) {
  const { chromium } = await import('playwright');
  // Asked before the browser exists, since afterwards the answer is always
  // the browser itself.
  const wasInFront = headless ? null : await whatIsInFront();
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
  if (!headless) {
    // The flag above is not enough on a Mac, where launching an application
    // makes it the active one whatever its windows do. The window is left
    // visible — a hidden one draws nothing and cannot be photographed — and
    // the front goes back to whatever the applicant was in.
    await giveBackTheFront(wasInFront);
  }
  if (blank) {
    // A lookup wants a browser, not an application. Loading the form for it
    // costs a page nobody asked for, and leaves an empty one to be
    // photographed by anything that later looks at the chat's page.
    return { browser, page };
  }
  await loadForm(page);
  return { browser, page };
}

/**
 * Puts the application form on a page, past the notice the site opens with.
 *
 * Split out so a browser opened blank for a lookup can be given the form
 * later, when something actually asks for one.
 */
export async function loadForm(page) {
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
  await acceptNoteModal(page);
  await waitForForm(page);
  return page;
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
  // The field just typed into is still focused, and the form checks a field
  // when it is left, not while it is being used. A capture taken with the
  // last field still held shows it outlined red against a value the site has
  // no complaint about — the ward, most often, being the last one set. So the
  // page is let go of first, and then the check is waited for below.
  await page.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
  // The uploaded portrait and passport page are drawn from data the site
  // fetches back, and a capture taken before they arrive shows empty frames
  // where the applicant is checking their own pictures.
  //
  // Only the pictures that are actually shown are waited for. The page keeps
  // two hidden images with no source of their own, which are loaded as far as
  // the browser is concerned and will never have a width: waiting on every
  // image meant waiting out the whole timeout, every time, on a page that had
  // nothing left to draw.
  await page
    .waitForFunction(
      () =>
        [...document.images]
          .filter(
            (image) =>
              image.offsetParent !== null &&
              image.getBoundingClientRect().width > 0
          )
          .every((image) => image.complete && image.naturalWidth > 0),
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
 * Takes the site's own chrome off the page while it is captured.
 *
 * The navigation bar and the step bar follow the window, so a capture of the
 * whole page draws them again at every scroll position and they land in the
 * middle of whichever part was being cut — the occupation part, most often.
 *
 * Hiding them is what takes them out of the capture. A sticky element that is
 * only made static keeps its place in the flow and is still drawn, which puts
 * it somewhere else on the page. Both bars are chrome, and every one of the
 * form's fields sits below them, so nothing worth checking goes with them.
 *
 * Returns what puts them back, so the applicant's own browser is left as it
 * was: they are looking at this page too.
 */
async function holdStillForCapture(page) {
  const marker = 'evisa-hold-still';
  // The pointer rests wherever the fill last clicked, and the site paints a
  // hovered select's border in the same red it uses for an error:
  //   .ant-select:not(.ant-select-disabled):hover .ant-select-selector
  //     { border-color: rgb(215, 26, 33) }
  // So a field came out ringed in red on a form the site had no complaint
  // about, and the applicant read it as an error and sent the value again.
  //
  // So before the picture: let go of the field, take the pointer off the
  // form, and overrule the rule. The first two are what a person would do;
  // the third is what makes it certain, since a pointer moved by a script
  // does not always leave the element it was over, and a window that never
  // had the pointer keeps whatever it was hovering when it lost it.
  await page
    .evaluate(() => {
      document.activeElement?.blur?.();
      // Something outside the form to hold the focus, so nothing on it is
      // drawn as the field being worked in.
      document.body.setAttribute('tabindex', '-1');
      document.body.focus({ preventScroll: true });
      // And told to let go of the pointer: the events a real mouse would
      // send on its way out, so anything listening for them settles too.
      for (const element of document.querySelectorAll(':hover')) {
        for (const type of ['mouseout', 'mouseleave']) {
          element.dispatchEvent(
            new MouseEvent(type, { bubbles: type === 'mouseout' })
          );
        }
      }
    })
    .catch(() => {});
  await page.mouse.move(2, 2).catch(() => {});
  // Injected by hand. Playwright's own `addStyleTag` drops the `id` it is
  // given, so the rule could never be found again to take away: every
  // capture left another copy on the page, and the one rule that mattered
  // was never there when the picture was taken.
  await page
    .evaluate((id) => {
      document.getElementById(id)?.remove();
      const style = document.createElement('style');
      style.id = id;
      style.textContent = `
        /* The site fades a border over 0.3s, so a field let go of a moment
           ago is still caught halfway back from its hover colour. Nothing
           animates while the picture is being taken. */
        *, *::before, *::after {
          transition: none !important;
          animation: none !important;
        }
        .navbar, .step-custom { display: none !important; }
        .ant-select:not(.ant-select-disabled):hover .ant-select-selector,
        .ant-input:hover,
        .ant-picker:hover {
          border-color: #d9d9d9 !important;
        }
        .ant-form-item-has-error .ant-select:not(.ant-select-disabled):hover
          .ant-select-selector,
        .ant-form-item-has-error .ant-input:hover,
        .ant-form-item-has-error .ant-picker:hover {
          border-color: #ff4d4f !important;
        }
      `;
      document.head.appendChild(style);
    }, marker)
    .catch(() => {});
  // Taking the bars away shortens the page above whatever is being measured,
  // so everything below them moves up. A measurement taken before the browser
  // has laid the page out again belongs to the page as it was, and cuts the
  // wrong band out of the page as it is — which is how the navigation came to
  // sit inside a section. Waited out here, so measuring and capturing agree.
  await page
    .evaluate(
      () =>
        new Promise((done) => {
          requestAnimationFrame(() => requestAnimationFrame(done));
        })
    )
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
  // Unhidden first: a window whose application was put behind when it opened
  // will not come forward for `bringToFront` alone.
  await takeTheFrontBack();
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
      if (next) {
        return {
          top: Math.max(0, top - 16),
          bottom: next.getBoundingClientRect().top + window.scrollY,
        };
      }
      // The last part runs to the end of the document, which takes in the
      // site's footer: its address, its hotline, its links. None of that is
      // the applicant's to check. The part ends under the buttons that close
      // the form, so the declaration and Next are shown and nothing after.
      const footer = document.querySelector(
        'footer, .footer, [class*="footer"]'
      );
      const buttons = [...document.querySelectorAll('button')]
        .filter((button) => button.offsetParent !== null)
        .map((button) => button.getBoundingClientRect().bottom + window.scrollY)
        .filter((edge) => edge > top);
      const end = footer
        ? footer.getBoundingClientRect().top + window.scrollY
        : document.documentElement.scrollHeight;
      const under = buttons.length ? Math.max(...buttons) + 24 : end;
      return { top: Math.max(0, top - 16), bottom: Math.min(end, under) };
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
  const { readFieldSections, groupBySection } =
    await import('./evisa-sections.mjs');
  // The page is asked where its fields are, so a form that has been
  // rearranged is still filled in its own order.
  const placement = await readFieldSections(page, FIELDS);
  const parts = groupBySection(applicant, placement);

  const result = {
    filled: [],
    typed: [],
    failures: [],
    sections: [],
    placed: {},
  };
  const take = (from) => {
    result.filled.push(...from.filled);
    result.typed.push(...from.typed);
    result.failures.push(...from.failures);
    // What the fill made of a value it was given, so the list the applicant
    // reads says what went on the form and not what was asked for.
    Object.assign(result.placed, from.placed ?? {});
  };

  // The pictures go up first, being at the top of the form. They are not
  // shown here: the loop below walks every part the page has, and the part
  // they belong to is one of them. Reporting them here as well sent the
  // applicant the same picture twice.
  if (uploads && Object.keys(uploads).length) {
    take(await fillForm(page, {}, { uploads }));
    await settleForm(page);
  }

  // Every part of the form is shown, in printed order, whether or not this
  // fill had anything to put in it: the applicant is checking all of them,
  // and a part that skipped its turn reads as one that went wrong.
  const filling = new Map(parts.map((part) => [part.at, part]));
  const shown = await presentSections(page);
  // The declarations are ticked before any part is shown. They sit inside the
  // parts about the trip and about its expenses, so ticking them afterwards
  // meant those parts were photographed with their boxes still empty: the
  // applicant was sent a form that was not the form on the screen.
  result.declared = await tickDeclarations(page);
  await settleForm(page, { timeout: 8000 });
  for (const { at, title } of shown) {
    const part = filling.get(at);
    if (part) {
      take(await fillForm(page, part.fields));
    }
    // Every part is settled before it is captured, whether or not this fill
    // wrote to it. A part with nothing to fill is not already still: the part
    // above it was just typed into, and the form is still re-laying itself out
    // underneath — captured then, it came out with its fields not yet drawn
    // and the site's bars caught partway through moving.
    await settleForm(page, { timeout: 8000 });
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

  // Ticked again, in case filling a part put a declaration back: the site
  // rebuilds a control now and then, and a box that came unticked must not
  // reach the applicant as ticked in their picture and empty on the form.
  const again = await tickDeclarations(page);
  if (again.ticked.length) {
    result.declared = {
      ...result.declared,
      ticked: [...result.declared.ticked, ...again.ticked],
    };
  }
  return result;
}

/**
 * The parts the form is showing, in printed order.
 *
 * Read from the page, so a form that has grown a part is still shown whole.
 */
export async function presentSections(page) {
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
