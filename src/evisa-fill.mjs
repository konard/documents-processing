// evisa-fill.mjs
//
// Drives the e-visa form in a real, headed browser.
//
// Filling and moving on are separate steps. The fill populates every field
// and ticks the declarations under the form; the browser is then left open on
// the finished form for the applicant to check. Pressing Next is a step of its
// own that a front end takes only on the applicant's word: the declarations
// are theirs, and the fee is not refunded when an application is refused.

import { FIELDS, RADIO_GROUPS, UPLOADS } from './evisa-schema.mjs';

export const FORM_URL = 'https://evisa.gov.vn/e-visa/foreigners';

/**
 * Accepts the NOTE modal that gates the form.
 *
 * The modal has two confirmation checkboxes and a Next button that stays
 * disabled until both are ticked. Angular only registers real user
 * gestures, so these must be genuine clicks; setting the DOM property is ignored.
 */
export async function acceptNoteModal(page) {
  await page.waitForSelector('input[type=checkbox]', { timeout: 60000 });

  // The modal scrolls its own content, and a checkbox only accepts a click once
  // it is in view, so scroll each one into place and confirm it actually took.
  const boxes = await page.$$('input[type=checkbox]');
  for (const box of boxes) {
    if (!(await box.isVisible())) {
      continue;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await box.isChecked()) {
        break;
      }
      await box.scrollIntoViewIfNeeded();
      await box.click({ force: true });
      await page.waitForTimeout(200);
    }
  }

  const next = page.locator('button:has-text("Next")');
  await next.waitFor({ state: 'visible', timeout: 30000 });
  // Next stays disabled until every confirmation is ticked.
  await page
    .waitForFunction(
      () =>
        ![...document.querySelectorAll('button')].some(
          (b) => b.innerText.trim() === 'Next' && b.disabled
        ),
      undefined,
      { timeout: 30000 }
    )
    .catch(() => {
      throw new Error(
        'the confirmation checkboxes in the NOTE dialog could not be ticked'
      );
    });
  await next.click();
  await page.waitForURL(/e-visa\/foreigners/, { timeout: 30000 });
}

/**
 * Waits for the application form itself to render.
 *
 * Dismissing the modal only routes to the form; Angular then builds the
 * controls. Filling before that lands keystrokes on elements that do not exist
 * yet, which fails silently.
 */
export async function waitForForm(page) {
  await page.waitForSelector('#basic_ttcnHo', { timeout: 60000 });
}

/**
 * Sets a value on a control without moving the page.
 *
 * Playwright scrolls an element into view before clicking it. That fights with
 * anyone scrolling the page themselves: each field yanks the view back, and a
 * control the reader has scrolled under the sticky header becomes unclickable.
 * Writing the value straight to the element avoids both.
 *
 * Angular listens for `input` and `change`, and its own value tracker has to be
 * bypassed or it treats the assignment as a no-op and reverts the field.
 */
function setValueInPlace(page, id, value) {
  return page.evaluate(
    ({ id, value }) => {
      const element = document.getElementById(id);
      if (!element) {
        return false;
      }
      const prototype = Object.getPrototypeOf(element);
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) {
        setter.call(element, value);
      } else {
        element.value = value;
      }
      for (const type of ['input', 'change', 'blur']) {
        element.dispatchEvent(new Event(type, { bubbles: true }));
      }
      return element.value === value;
    },
    { id, value: String(value) }
  );
}

/** Fills a plain text input, leaving the page scroll where the reader put it. */
export async function fillText(page, id, value) {
  const applied = await setValueInPlace(page, id, value);
  if (!applied) {
    throw new Error(`could not set ${id}`);
  }
}

/**
 * Fills a DD/MM/YYYY date input.
 *
 * These inputs are readonly and backed by a date picker, so the value has to be
 * typed and then committed with Enter. Escape looks like it works — the text is
 * visible while typing — but the picker discards it and the field ends up empty.
 */
export async function fillDate(page, id, value) {
  const input = page.locator(`#${id}`);

  // Setting the value directly is enough for the picker to accept it, and it
  // leaves the page scroll alone.
  const applied = await setValueInPlace(page, id, value);
  if (!applied) {
    // Fall back to typing, which needs focus and therefore scrolls.
    await input.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(String(value), { delay: 20 });
    await page.keyboard.press('Enter');
  }

  const committed = await input.inputValue();
  if (committed !== String(value)) {
    throw new Error(
      `date ${id} did not take the value ${value} (shows "${committed}")`
    );
  }
}

/**
 * Chooses a value in an Ant Design select.
 *
 * These inputs are readonly, so the value cannot be typed. Clicking opens a
 * floating option list rendered outside the field, and the matching option has
 * to be clicked. An exact, case-insensitive match wins; otherwise the single
 * option that contains the value is used. An ambiguous match raises an error,
 * because guessing at someone's nationality or border gate is not safe.
 */
export async function fillSelect(page, id, value) {
  const input = page.locator(`#${id}`);

  // Opening the dropdown needs a click, but Playwright's would scroll the page.
  // Dispatching it on the element leaves the scroll position untouched.
  await page.evaluate((id) => {
    const element = document.getElementById(id);
    // The handler sits on the inner selector element; the outer wrapper
    // ignores the event.
    const target =
      element?.closest('.ant-select')?.querySelector('.ant-select-selector') ??
      element;
    target?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    );
    element?.focus({ preventScroll: true });
  }, id);

  // Ant Design keeps one dropdown per select and leaves earlier ones in the
  // document, so the options are scoped to the panel holding this select's own
  // list. The list element carries the id; the options sit beside it.
  const listId = `${id}_list`;
  const options = page.locator(
    `.ant-select-dropdown:has(#${listId}) .ant-select-item-option`
  );
  await options.first().waitFor({ state: 'visible', timeout: 15000 });

  // A searchable select filters its list as text is entered. Filtering is only
  // worth doing when the list is long enough that the wanted option may not be
  // rendered yet; on a short list it risks filtering everything away, since the
  // site matches on its own wording and the value may be phrased differently.
  const searchable = !(await input.evaluate((el) => el.readOnly));
  let texts = (await options.allTextContents()).map((t) => t.trim());
  const wantedText = String(value).trim().toLowerCase();
  const alreadyListed = texts.some(
    (t) =>
      t.toLowerCase() === wantedText || t.toLowerCase().includes(wantedText)
  );

  if (searchable && !alreadyListed) {
    // Setting the search text keeps the page still; typing would move it,
    // because the keystrokes need focus and focus scrolls.
    await setValueInPlace(page, id, value);
    await page.waitForTimeout(500);
    texts = (await options.allTextContents()).map((t) => t.trim());
  }
  if (texts.length === 0) {
    throw new Error(`no options matched "${value}" for ${id}`);
  }

  const wanted = String(value).trim().toLowerCase();
  let index = texts.findIndex((t) => t.toLowerCase() === wanted);
  if (index === -1) {
    const partial = texts
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.toLowerCase().includes(wanted));
    if (partial.length === 1) {
      index = partial[0].i;
    } else if (partial.length > 1) {
      throw new Error(
        `"${value}" matches ${partial.length} options for ${id}: ${partial
          .map(({ t }) => t)
          .join(', ')}`
      );
    } else {
      throw new Error(`no option matches "${value}" for ${id}`);
    }
  }

  // Playwright scrolls before clicking even a floating option, which drags the
  // form with it, so the click is dispatched on the element instead.
  // Matched by text, since a searchable list re-renders as it filters and an
  // index taken before that no longer points at the same option.
  const chosen = texts[index];
  const clicked = await page.evaluate(
    ({ wanted, listId }) => {
      // The element carrying the id is an ARIA helper; the options sit in the
      // dropdown panel around it.
      const panel = document
        .getElementById(listId)
        ?.closest('.ant-select-dropdown');
      const list = [
        ...(panel?.querySelectorAll('.ant-select-item-option') ?? []),
      ];
      const option = list.find(
        (item) => (item.textContent ?? '').trim() === wanted
      );
      if (!option) {
        return false;
      }
      for (const type of ['mousedown', 'mouseup', 'click']) {
        option.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true })
        );
      }
      return true;
    },
    { wanted: chosen, listId }
  );
  if (!clicked) {
    throw new Error(`option "${chosen}" disappeared from the list for ${id}`);
  }

  // Close this dropdown, so the next field does not read a list still on screen.
  await page.evaluate((id) => {
    document.getElementById(id)?.blur();
  }, id);
  await page.waitForTimeout(200);
  return chosen;
}

/**
 * Selects a radio option by the question text above it, since radio inputs on
 * this form carry neither ids nor names.
 */
export async function fillRadio(page, question, option) {
  const clicked = await page.evaluate(
    ({ question, option }) => {
      const radios = [...document.querySelectorAll('input[type=radio]')];
      for (const radio of radios) {
        const label = radio.closest('label');
        const text = (label?.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.toLowerCase() !== option.toLowerCase()) {
          continue;
        }
        // Walk up until a block that also contains the question text, so the
        // right "No" is picked among the form's many yes/no pairs.
        let node = radio.parentElement;
        for (let i = 0; i < 8 && node; i++) {
          const block = (node.innerText || '').replace(/\s+/g, ' ');
          if (block.includes(question)) {
            // Clicking focuses the control, and focusing scrolls it into view.
            // Restoring the offset afterwards keeps the reader's position.
            const x = window.scrollX;
            const y = window.scrollY;
            label?.click();
            window.scrollTo(x, y);
            return true;
          }
          node = node.parentElement;
        }
      }
      return false;
    },
    { question, option }
  );
  if (!clicked) {
    throw new Error(
      `could not find radio "${option}" for question "${question}"`
    );
  }
}

/** Attaches a local file to one of the two upload inputs. */
export async function uploadFile(page, id, filePath) {
  // setInputFiles scrolls the input into view, so the offset is restored after.
  const before = await page.evaluate(() => [window.scrollX, window.scrollY]);
  await page.setInputFiles(`#${id}`, filePath);
  await page.evaluate(([x, y]) => window.scrollTo(x, y), before);

  // The site checks each image server-side, and for the passport it then fills
  // several fields from what it read. Waiting for a field to appear beats
  // guessing a duration: the round trip took over five seconds when measured,
  // and reading too early makes its extraction look absent.
  await page
    .waitForFunction(
      () => (document.getElementById('basic_ttcnHo')?.value ?? '') !== '',
      undefined,
      { timeout: 30000 }
    )
    .catch(() => {});
  await page.waitForTimeout(1000);
}

/**
 * Fills the whole form from a normalized applicant record.
 *
 * Uploads run first because the site reads the passport image and pre-populates
 * fields from it; typing afterwards means our verified values win.
 *
 * A failure on one field is recorded and the rest still get filled, so the user
 * sees a mostly complete form plus an exact list of what needs attention.
 */
/** Types one field using the strategy its kind calls for. */
async function fillField(page, field, value) {
  if (field.kind === 'date') {
    await fillDate(page, field.id, value);
  } else if (field.kind === 'select') {
    await fillSelect(page, field.id, value);
  } else {
    await fillText(page, field.id, value);
  }
}

/**
 * Reads what the site has already put in the form.
 *
 * After the passport image is uploaded the site runs its own extraction and
 * fills several fields, telling the applicant to double-check them. Those
 * values are worth reading before anything is typed, so a field it got right
 * is left alone.
 */
export function readFilledFields(page) {
  return page.evaluate((fields) => {
    const out = {};
    for (const [name, field] of Object.entries(fields)) {
      const element = document.getElementById(field.id);
      if (!element) {
        continue;
      }
      const selected = element
        .closest('.ant-select')
        ?.querySelector('.ant-select-selection-item')
        ?.textContent?.trim();
      const value = selected || element.value;
      if (value) {
        out[name] = value;
      }
    }
    return out;
  }, FIELDS);
}

/** The options a select is offering, without disturbing the page. */
export async function selectOptions(page, id) {
  await page.locator(`#${id}`).click();
  await page.waitForTimeout(1200);
  // Scoped to this select's own panel. Ant Design keeps one dropdown per
  // select and leaves the last one in the document while it fades, so reading
  // every visible dropdown read whichever field was filled before this one:
  // the ward was offered the province's list, and took KHANH HOA — an option
  // the site accepts, so nothing failed and a province was filed as a ward.
  const texts = await page.evaluate(
    (listId) =>
      [
        ...(document
          .getElementById(listId)
          ?.closest('.ant-select-dropdown')
          ?.querySelectorAll('.ant-select-item-option-content') ?? []),
      ].map((option) => option.innerText.trim()),
    `${id}_list`
  );
  await page.keyboard.press('Escape');
  return texts;
}

/**
 * Places the ward against the list the site is offering for its province.
 *
 * Viet Nam merged its wards, so a booking may still name one the form no
 * longer lists; the city's own ward is where such a ward ended up. A ward
 * that cannot be placed is dropped, since an unfillable value fails the
 * field and leaves the applicant with an error to read.
 */
async function resolveWard(page, applicant) {
  const wanted = applicant.wardInVietnam;
  if (!wanted || !applicant.provinceInVietnam) {
    return applicant;
  }
  try {
    await fillSelect(
      page,
      FIELDS.provinceInVietnam.id,
      applicant.provinceInVietnam
    );
    const options = await selectOptions(page, FIELDS.wardInVietnam.id);
    if (!options.length) {
      return applicant;
    }
    // A list that is really the province's own, read while its dropdown was
    // still on screen. Filing a province as a ward is worse than filing no
    // ward at all, since the site accepts it and nobody is told.
    const same = (a, b) =>
      String(a).toUpperCase().replace(/\s+/g, ' ').trim() ===
      String(b).toUpperCase().replace(/\s+/g, ' ').trim();
    if (options.some((option) => same(option, applicant.provinceInVietnam))) {
      return applicant;
    }
    const { matchWard } = await import('./evisa-vietnam-address.mjs');
    const placed = matchWard(wanted, options, applicant.townInVietnam);
    if (!placed) {
      // Dropping it silently left a required field empty and erroring while
      // the fill reported nothing wrong. The value is kept, so the ordinary
      // attempt fails on it and the applicant is told which ward it was.
      return applicant;
    }
    return { ...applicant, wardInVietnam: placed };
  } catch {
    // A province that will not take, or a list that will not open, leaves
    // the ward as it was for the ordinary attempt to report on.
    return applicant;
  }
}

export async function fillForm(page, applicant, { uploads = {} } = {}) {
  const filled = [];
  const typed = [];
  const failures = [];

  // One field failing leaves the rest fillable, so each is attempted on its own
  // and its error recorded against the field name.
  const attempt = async (key, action) => {
    try {
      await action();
      filled.push(key);
      typed.push(key);
    } catch (error) {
      failures.push({ field: key, error: error.message });
    }
  };

  // The ward list belongs to the province and changes with it, and Viet Nam
  // has merged wards, so a ward a booking still names may be gone. The value
  // is placed against the list the site is actually offering.
  const applicantToFill = await resolveWard(page, applicant);

  // What the page held before the uploads, so what the site puts there from
  // the passport can be told from what an earlier fill left.
  const before = await readFilledFields(page);

  applicant = applicantToFill;

  for (const [key, meta] of Object.entries(UPLOADS)) {
    if (uploads[key]) {
      await attempt(key, () => uploadFile(page, meta.id, uploads[key]));
    }
  }

  for (const [key, group] of Object.entries(RADIO_GROUPS)) {
    if (applicant[key]) {
      await attempt(key, () => fillRadio(page, group.question, applicant[key]));
    }
  }

  // The site fills several fields from the passport image it was just given.
  // Reading them first means a value it got right is left untouched, and only
  // a genuine disagreement is overwritten. Only a value the upload changed
  // counts as the site's reading; the rest is the page as it was.
  const extracted = await readFilledFields(page);
  const siteRead = new Set(
    Object.keys(extracted).filter((key) => extracted[key] !== before[key])
  );
  const corrected = [];
  const agreed = [];
  // What the site read and we did not: worth surfacing, since it is a value
  // going onto the form that no reading of ours confirms.
  const siteOnly = [...siteRead].filter(
    (key) => !applicant[key] && FIELDS[key]
  );

  for (const [key, field] of Object.entries(FIELDS)) {
    const value = applicant[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    const already = extracted[key];
    if (already) {
      const same =
        String(already).trim().toUpperCase() ===
        String(value).trim().toUpperCase();
      if (same) {
        // On the page already, whether the site read it or an earlier fill
        // set it; either way it is not typed again.
        filled.push(key);
        if (siteRead.has(key)) {
          agreed.push(key);
        }
        continue;
      }
      if (siteRead.has(key)) {
        corrected.push({ field: key, was: already, now: value });
      }
    }
    await attempt(key, () => fillField(page, field, value));
  }

  return { filled, typed, failures, extracted, corrected, agreed, siteOnly };
}

/**
 * The declarations under the form, each known by what its label says.
 *
 * Next stays disabled until all four are ticked. The site's "agree to create
 * an account by email" box comes ticked and is not one of them.
 */
export const DECLARATIONS = {
  temporaryResidence: 'temporary residence',
  truthful: 'hereby declare',
  compliance: 'compliance with vietnamese laws',
  instructionsRead: 'reading carefully instructions',
};

/**
 * Ticks the declarations under the form and says which it ticked, which it
 * found ticked, and which it did not find on the page.
 *
 * Found by their wording, since the site gives most of them no id. The click
 * goes to the label, not the box: Angular listens on the label.
 */
export function tickDeclarations(page) {
  return page.evaluate((declarations) => {
    const ticked = [];
    const already = [];
    const missing = [];
    const labels = [...document.querySelectorAll('label')];
    for (const [key, words] of Object.entries(declarations)) {
      const label = labels.find(
        (candidate) =>
          candidate.querySelector('input[type=checkbox]') &&
          candidate.innerText.toLowerCase().includes(words)
      );
      if (!label) {
        missing.push(key);
        continue;
      }
      const box = label.querySelector('input[type=checkbox]');
      if (box.checked) {
        already.push(key);
        continue;
      }
      // Clicking focuses the box, and focusing scrolls it into view, which
      // yanks the page from under a reader who is scrolling it. Restoring
      // the offset afterwards keeps their position.
      const x = window.scrollX;
      const y = window.scrollY;
      label.click();
      window.scrollTo(x, y);
      ticked.push(key);
    }
    return { ticked, already, missing };
  }, DECLARATIONS);
}

/** The validation messages the form shows, top to bottom. */
export function readValidationErrors(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.ant-form-item-explain-error')]
      .map((element) => element.innerText.trim())
      .filter(Boolean)
  );
}

/**
 * The application's stages, as the step bar at the top of the page names
 * them. The address does not change between them: the site is one page
 * that swaps its content, so the step bar is what says where it is.
 */
export const STAGES = {
  form: 'fill out the application form',
  review: 'review application form',
  payment: 'payment',
};

/** A dialog the site has open: what it says, line by line, and its buttons. */
const DIALOG_SELECTOR = '.ant-modal-wrap:not([style*="display: none"])';

/**
 * The dialog the site has open, or null: its lines, without the buttons'
 * labels, and the buttons by label. Nothing is clicked: a dialog's buttons
 * do things, "Print" and "Confirm" among them, and which to press is the
 * applicant's call.
 */
export function readDialog(page) {
  return page.evaluate((selector) => {
    const wrap = document.querySelector(selector);
    const body = wrap?.querySelector('.ant-modal-body');
    if (!wrap || !body || !wrap.offsetWidth) {
      return null;
    }
    const buttons = [...wrap.querySelectorAll('button')]
      .map((button) => button.innerText.trim())
      .filter(Boolean);
    const lines = body.innerText
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line && !buttons.includes(line));
    return { lines, buttons };
  }, DIALOG_SELECTOR);
}

/**
 * The stage the page is at: a key of STAGES; 'declared' while the site's
 * "declaration completed" dialog stands over the review page, a stage the
 * step bar does not show; or 'unknown'.
 */
export async function readStage(page) {
  const dialog = await readDialog(page);
  if (
    dialog &&
    (dialog.buttons.includes('Confirm') ||
      dialog.lines.some((line) => /declaration completed/i.test(line)))
  ) {
    return 'declared';
  }
  const active = await page.evaluate(
    () =>
      document
        .querySelector('.ant-steps-item-active')
        ?.innerText.replace(/\s+/g, ' ')
        .trim()
        .toLowerCase() ?? ''
  );
  return (
    Object.keys(STAGES).find((key) => active.includes(STAGES[key])) ?? 'unknown'
  );
}

/** Where the site puts what it has to say: a dialog, a message, a toast. */
const NOTICE_SELECTOR = `${DIALOG_SELECTOR} .ant-modal-body, .ant-message-notice, .ant-notification-notice`;

/**
 * What the site says in a dialog or a toast, such as "Captcha invalid".
 * Nothing is closed: a toast closes itself, and a dialog is the site's
 * next step, for the applicant to take. The toast's own title,
 * "Notification", is dropped.
 */
export function readNotices(page) {
  return page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)]
        .map((element) =>
          element.innerText
            .replace(/\s+/g, ' ')
            .replace(/^Notification\s*/i, '')
            .trim()
        )
        .filter(Boolean),
    NOTICE_SELECTOR
  );
}

/**
 * Presses a button on the page by its label, "Next" or "Confirm", and
 * reports where that led.
 *
 * A page the site accepts moves to the next stage, or puts up its dialog;
 * one it does not stays put, with validation messages on the form or a
 * notice from the site. The button that is looked for is the visible one:
 * the NOTE dialog's own Next stays in the document, hidden.
 */
export async function pressButton(page, label = 'Next') {
  const from = await readStage(page);
  const button = page.locator(`button:has-text("${label}"):visible`);
  if (!(await button.count())) {
    throw new Error(`there is no ${label} button on this page`);
  }
  if (await button.first().isDisabled()) {
    throw new Error(`the ${label} button is disabled`);
  }
  const activeBefore = await page.evaluate(
    () => document.querySelector('.ant-steps-item-active')?.innerText ?? ''
  );
  const dialogBefore = Boolean(await readDialog(page));
  await button.first().click();
  await page
    .waitForFunction(
      ({ before, selector, hadDialog }) =>
        (document.querySelector('.ant-steps-item-active')?.innerText ?? '') !==
          before ||
        (hadDialog
          ? !document.querySelector(selector)
          : document.querySelector(
              `.ant-form-item-explain-error, ${selector}, .ant-message-notice, .ant-notification-notice`
            )),
      {
        before: activeBefore,
        selector: DIALOG_SELECTOR,
        hadDialog: dialogBefore,
      },
      { timeout: 30000 }
    )
    .catch(() => {});
  const stage = await readStage(page);
  const moved = stage !== from;
  const errors = moved ? [] : await readValidationErrors(page);
  const notices = moved ? [] : await readNotices(page);
  const dialog = await readDialog(page);
  return { from, stage, moved, errors, notices, dialog, url: page.url() };
}

/** Presses Next: the button that moves the application on. */
export function pressNext(page) {
  return pressButton(page, 'Next');
}

/** The captcha input's id on the review page. */
const CAPTCHA_ID = 'basic_captcha';

/**
 * The captcha the review page shows, as PNG bytes, or null when the page
 * shows none. The image is embedded in the page as data, so it is read
 * from there without another request.
 */
export async function readCaptcha(page) {
  // The review page draws its captcha a moment after the step bar moves.
  await page
    .waitForSelector('img[alt="captcha img"]', { timeout: 15000 })
    .catch(() => {});
  const src = await page.evaluate(
    () => document.querySelector('img[alt="captcha img"]')?.src ?? null
  );
  const match = src && /^data:image\/\w+;base64,\s*(.+)$/s.exec(src);
  return match ? Buffer.from(match[1], 'base64') : null;
}

/** Asks the site for another captcha, and waits for it to arrive. */
export async function refreshCaptcha(page) {
  const before = await page.evaluate(
    () => document.querySelector('img[alt="captcha img"]')?.src ?? ''
  );
  await page.locator('img[alt="reload"]').first().click();
  await page
    .waitForFunction(
      (old) =>
        (document.querySelector('img[alt="captcha img"]')?.src ?? '') !== old,
      before,
      { timeout: 15000 }
    )
    .catch(() => {});
}

/** Types the captcha's code into the review page. */
export async function fillCaptcha(page, code) {
  await page.waitForSelector(`#${CAPTCHA_ID}`, { timeout: 15000 });
  await fillText(page, CAPTCHA_ID, String(code).trim());
}

/** Captures the whole filled form, including the parts below the fold. */
export async function screenshotForm(page, outputPath) {
  await page.screenshot({ path: outputPath, fullPage: true });
  return outputPath;
}
