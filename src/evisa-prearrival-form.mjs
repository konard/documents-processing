// evisa-prearrival-form.mjs
//
// Driving the pre-arrival declaration at prearrival.immigration.gov.vn.
//
// The visa form and this one are different sites with different owners, and
// nothing but the traveller is shared. What is shared is the shape of the
// work: open a page, get past what gates it, type what is known, show the
// result, and leave the sending to the applicant. So this reads like
// evisa-session.mjs, but it does not borrow that site's typing helpers: those
// address fields by id and speak Ant Design, while this form is Material UI
// addressed by name, and its upload waits on a visa-form field that does not
// exist here. The helpers below are this site's own.
//
// Three things about this site are its own, and each one shaped the code:
//
//   * A CAPTCHA gates the whole application, before a single field is drawn.
//     It cannot be avoided by any route: /apps/submit-document shows it on
//     arrival. So the declaration always begins by asking the chat to read a
//     picture, the way the visa form's own captcha is asked for.
//
//   * Fields are numbered per passenger: 0_passportNumber, 0_dob, 0_visa*.
//     The site takes a party on one declaration through "Add Passenger +",
//     and the numbering is how it tells them apart.
//
//   * The arrival date is a choice of three radio buttons — today and the two
//     days after, in GMT+7 — not a date to type. The site takes a declaration
//     only within three days of landing, so one cannot be filed early.

import { giveBackTheFront, whatIsInFront } from './evisa-window.mjs';

/** Where a declaration is made. */
export const PREARRIVAL_FORM_URL =
  'https://prearrival.immigration.gov.vn/apps/submit-document';

/**
 * How many days ahead the site will take a declaration, counting today.
 *
 * The form offers three arrival dates and no way to type a fourth, so a
 * traveller landing later than that has nothing to file yet.
 */
export const ARRIVAL_WINDOW_DAYS = 3;

/**
 * The site's own name for a country, where it differs from the visa form's.
 *
 * Both ask for a nationality and neither spells it the same way, so a value
 * that filled the application does not always match an option here.
 */
const NATIONALITY_NAMES = new Map([
  ['russia', 'Russian Federation'],
  ['russian federation', 'Russian Federation'],
]);

/** What this site calls the nationality the application recorded. */
export function nationalityAsNamedHere(nationality) {
  if (!nationality) {
    return null;
  }
  return (
    NATIONALITY_NAMES.get(String(nationality).toLowerCase()) ?? nationality
  );
}

/**
 * The declaration's fields, by the name the page gives each input.
 *
 * `index` marks the ones numbered per passenger, which take the traveller's
 * position as a prefix. `how` says what kind of control it is, since a date
 * is typed, a nationality is chosen from a list that filters as you type, and
 * a gender is a radio button.
 */
export const FORM_FIELDS = [
  { key: 'passportType', name: 'passportType', how: 'select', index: true },
  { key: 'passportNumber', name: 'passportNumber', how: 'text', index: true },
  { key: 'passportExpiryDate', name: 'expiryDate', how: 'date', index: true },
  { key: 'surname', label: 'Surname', how: 'text' },
  { key: 'givenName', label: 'Given Name', how: 'text' },
  { key: 'dateOfBirth', name: 'dob', how: 'date', index: true },
  { key: 'nationality', name: 'nationality', how: 'select', index: true },
  { key: 'phone', name: 'phone', how: 'text', index: true },
  { key: 'email', name: 'email', how: 'text', index: true },
  { key: 'visaType', name: 'visaType', how: 'select', index: true },
  { key: 'visaNumber', name: 'visaNumber', how: 'text', index: true },
  { key: 'visaIssueDate', name: 'visaIssueDate', how: 'date', index: true },
  { key: 'visaExpiryDate', name: 'visaExpiryDate', how: 'date', index: true },
  {
    key: 'visaIssuedPlace',
    name: 'visaIssuedPlace',
    how: 'select',
    index: true,
  },
];

/** The selector for a field, for the passenger at `at`. */
export function selectorFor(field, at = 0) {
  return `[name="${field.index ? `${at}_` : ''}${field.name}"]`;
}

/**
 * The input for a field, whether it is named or only labelled.
 *
 * Surname and Given Name carry no name attribute. Their labels point at ids
 * React generates — ":re:", ":rf:" — which are neither stable across renders
 * nor usable in a selector, so those two are found by their label text.
 */
export function inputFor(page, field, at = 0) {
  if (field.name) {
    return page.locator(selectorFor(field, at)).first();
  }
  return page.getByLabel(field.label, { exact: true }).first();
}

/**
 * Types into a plain text input, the way a person would.
 *
 * Material UI keeps its own copy of what a field holds and only updates it
 * from the events a keypress raises, so a value written straight to the DOM
 * is shown but not kept: the form submits the empty string it still believes
 * in. Everything here is typed for that reason.
 */
export async function typeInto(input, value, named = 'the field') {
  await input.waitFor({ state: 'visible', timeout: 20000 });
  await input.fill('');
  await input.type(String(value), { delay: 15 });
  const shows = await input.inputValue();
  if (shows !== String(value)) {
    throw new Error(`${named} shows "${shows}", not "${value}"`);
  }
}

/**
 * Chooses a value in a Material UI Autocomplete.
 *
 * The list filters as you type and is drawn outside the field, so the value
 * is typed and then the option clicked. An exact match wins; otherwise the
 * one option that contains the value is taken. Anything more ambiguous than
 * that raises, since guessing at somebody's nationality is not safe.
 */
export async function chooseFrom(page, input, value, named = 'the field') {
  await input.waitFor({ state: 'visible', timeout: 20000 });
  await input.fill('');
  await input.type(String(value), { delay: 25 });
  const options = page.locator('[role=option]');
  await options.first().waitFor({ state: 'visible', timeout: 10000 });
  const texts = (await options.allTextContents()).map((t) => t.trim());
  const wanted = String(value).toLowerCase();
  let at = texts.findIndex((t) => t.toLowerCase() === wanted);
  if (at < 0) {
    const holding = texts
      .map((t, index) => ({ t, index }))
      .filter(({ t }) => t.toLowerCase().includes(wanted));
    if (holding.length !== 1) {
      throw new Error(
        `${named}: "${value}" matches ${holding.length} of ${texts.length} options`
      );
    }
    at = holding[0].index;
  }
  await options.nth(at).click();
}

/**
 * Opens a browser on the declaration, stopping at the captcha that gates it.
 *
 * The caller is handed the page with the dialog still up, because reading the
 * picture is the applicant's to do and nothing can be filled until they have.
 */
export async function openDeclaration({
  headless = false,
  debugPort = 0,
  viewport,
} = {}) {
  const { chromium } = await import('playwright');
  const wasInFront = headless ? null : await whatIsInFront();
  const args = headless
    ? []
    : ['--window-size=1500,1000', '--no-startup-window-activation'];
  if (debugPort) {
    args.push(`--remote-debugging-port=${debugPort}`);
  }
  const browser = await chromium.launch({ headless, args });
  const context = await browser.newContext(
    viewport ? { viewport } : { viewport: null }
  );
  const page = await context.newPage();
  await page.goto(PREARRIVAL_FORM_URL, { waitUntil: 'domcontentloaded' });
  // The page answers before React has drawn the gate, so a caller asking
  // straight away is told there is no captcha and walks into one.
  await page
    .locator('[role=dialog]:has-text("CAPTCHA")')
    .waitFor({ state: 'visible', timeout: 30000 })
    .catch(() => {});
  if (!headless) {
    await giveBackTheFront(wasInFront);
  }
  return { browser, context, page };
}

/** Whether the captcha dialog is up, which is how the site opens. */
export function captchaIsUp(page) {
  return page
    .locator('[role=dialog]:has-text("CAPTCHA")')
    .isVisible()
    .catch(() => false);
}

/**
 * Types a captcha code and verifies it.
 *
 * Returns whether the dialog went away, which is the site's only answer: a
 * wrong code leaves it up, with a fresh picture to read.
 */
export async function answerCaptcha(page, code) {
  const dialog = page.locator('[role=dialog]');
  await dialog.locator('input').fill(String(code).trim());
  await dialog.getByRole('button', { name: 'Verify' }).click();
  await page
    .waitForSelector('[role=dialog]', { state: 'detached', timeout: 15000 })
    .catch(() => {});
  return !(await captchaIsUp(page));
}

/**
 * Chooses the nationality and moves on to the form itself.
 *
 * The site asks for it alone on the first step, then carries it in the URL,
 * so this is the one step that decides which form is drawn.
 */
export async function chooseNationality(page, nationality) {
  const named = nationalityAsNamedHere(nationality);
  const box = page.locator('input[name="nationality"]');
  await box.waitFor({ state: 'visible', timeout: 20000 });
  await box.fill('');
  await box.type(named, { delay: 30 });
  const option = page.locator('[role=option]').first();
  await option.waitFor({ state: 'visible', timeout: 10000 });
  await option.click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.waitForURL(/\/foreign\?nat=/, { timeout: 20000 });
  return named;
}

/**
 * The arrival dates the site is willing to take, as it prints them.
 *
 * Three buttons, today first, in GMT+7: the timezone Vietnam keeps, which is
 * not always the one the traveller is in when they declare.
 */
export async function offeredArrivalDates(page) {
  const wanted = /^\d{2}\/\d{2}\/\d{4}$/;
  const labels = await page
    .locator('button, label')
    .allTextContents()
    .catch(() => []);
  return [
    ...new Set(labels.map((t) => t.trim()).filter((t) => wanted.test(t))),
  ];
}

/**
 * Picks the arrival date, and says so when the site will not take it.
 *
 * A traveller landing beyond the window has no declaration to make yet; the
 * site simply does not offer the day. That is worth saying plainly rather
 * than filling in the nearest date, which would be a false declaration.
 */
export async function chooseArrivalDate(page, arrivalDate) {
  const offered = await offeredArrivalDates(page);
  if (!offered.includes(arrivalDate)) {
    return { chosen: null, offered, tooEarly: true };
  }
  await page.getByRole('button', { name: arrivalDate, exact: true }).click();
  return { chosen: arrivalDate, offered, tooEarly: false };
}

/** Picks a gender, which the site asks for as radio buttons. */
export async function chooseGender(page, sex) {
  const wanted = String(sex ?? '')
    .toLowerCase()
    .startsWith('f')
    ? 'Female'
    : 'Male';
  await page
    .getByRole('radio', { name: wanted })
    .check()
    .catch(() => {});
  return wanted;
}

/**
 * The three controls that are not text: the date, the picture, the gender.
 *
 * Each is answered its own way — a button among three, a file, a radio — so
 * they are done together, ahead of the typing.
 */
async function fillTheRest(page, applicant, { passportImage, filled, failed }) {
  if (applicant.arrivalDate) {
    const picked = await chooseArrivalDate(page, applicant.arrivalDate);
    if (picked.tooEarly) {
      return picked;
    }
    filled.push('arrivalDate');
  }
  if (passportImage) {
    // The site reads the picture on its own server and fills what it finds
    // from it. The typing that follows therefore waits for that, and corrects
    // whatever it read.
    await page
      .setInputFiles('input[name="passportImage"]', passportImage)
      .then(() => page.waitForTimeout(3000))
      .catch((error) => failed.push(`passportImage: ${error.message}`));
  }
  if (applicant.sex) {
    await chooseGender(page, applicant.sex);
    filled.push('sex');
  }
  return null;
}

/**
 * Fills the declaration with everything known about one traveller.
 *
 * Nothing is invented: a value the record has not got is left empty and named
 * in what comes back, so the chat can ask for it.
 */
export async function fillDeclaration(
  page,
  applicant = {},
  { at = 0, passportImage = null } = {}
) {
  const filled = [];
  const missing = [];
  const failed = [];

  const tooEarly = await fillTheRest(page, applicant, {
    passportImage,
    filled,
    failed,
  });
  if (tooEarly) {
    return { filled, missing, failed, arrival: tooEarly };
  }

  for (const field of FORM_FIELDS) {
    const value =
      field.key === 'nationality'
        ? nationalityAsNamedHere(applicant.nationality)
        : applicant[field.key];
    if (value === null || value === undefined || value === '') {
      missing.push(field.key);
      continue;
    }
    const input = inputFor(page, field, at);
    try {
      // A date here is a plain DD/MM/YYYY text field, not the readonly picker
      // the visa form uses, so it is typed like any other text.
      if (field.how === 'select') {
        await chooseFrom(page, input, value, field.key);
      } else {
        await typeInto(input, value, field.key);
      }
      filled.push(field.key);
    } catch (error) {
      failed.push(`${field.key}: ${error.message}`);
    }
  }

  return { filled, missing, failed, arrival: null };
}

/** What the page holds now, read back so a fill can be checked. */
export async function readDeclaration(page, at = 0) {
  const values = {};
  for (const field of FORM_FIELDS) {
    const value = await inputFor(page, field, at)
      .inputValue()
      .catch(() => null);
    if (value) {
      values[field.key] = value;
    }
  }
  return values;
}
