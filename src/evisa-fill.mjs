// evisa-fill.mjs
//
// Drives the e-visa form in a real, headed browser.
//
// The form is never submitted. The browser is left open on a fully populated
// form so the applicant can check every field, correct anything, and press
// submit themselves. Submitting on someone's behalf would mean signing a legal
// declaration for them, which this tool deliberately does not do.

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

/** Types into a plain text input, clearing whatever was there first. */
export async function fillText(page, id, value) {
  const input = page.locator(`#${id}`);
  await input.click();
  await input.fill('');
  await input.type(String(value), { delay: 10 });
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
  await input.click();
  // A readonly input rejects fill(), so clear it with the keyboard instead.
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(String(value), { delay: 20 });
  await page.keyboard.press('Enter');

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
  await input.click();

  const options = page.locator(
    '.ant-select-dropdown:visible .ant-select-item-option'
  );
  await options.first().waitFor({ state: 'visible', timeout: 15000 });

  // A searchable select filters its list as you type, which makes long lists
  // such as nationality usable; a plain one ignores the keystrokes.
  const searchable = !(await input.evaluate((el) => el.readOnly));
  if (searchable) {
    await page.keyboard.type(String(value), { delay: 20 });
    await page.waitForTimeout(500);
  }

  const texts = (await options.allTextContents()).map((t) => t.trim());
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

  await options.nth(index).click();
  await page.waitForTimeout(200);
  return texts[index];
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
            label?.click();
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
  await page.setInputFiles(`#${id}`, filePath);
  // The site verifies each image server-side and may auto-fill passport fields
  // from it, so give that round trip a moment before the next action.
  await page.waitForTimeout(2500);
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

export async function fillForm(page, applicant, { uploads = {} } = {}) {
  const filled = [];
  const failures = [];

  // One field failing leaves the rest fillable, so each is attempted on its own
  // and its error recorded against the field name.
  const attempt = async (key, action) => {
    try {
      await action();
      filled.push(key);
    } catch (error) {
      failures.push({ field: key, error: error.message });
    }
  };

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

  for (const [key, field] of Object.entries(FIELDS)) {
    const value = applicant[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    await attempt(key, () => fillField(page, field, value));
  }

  return { filled, failures };
}

/** Captures the whole filled form, including the parts below the fold. */
export async function screenshotForm(page, outputPath) {
  await page.screenshot({ path: outputPath, fullPage: true });
  return outputPath;
}
