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
