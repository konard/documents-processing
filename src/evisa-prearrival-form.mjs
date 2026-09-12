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

/**
 * The site's own wording for a kind of passport.
 *
 * Its options read "P - Popular Passport", so the letter the visa
 * application records matches all three of them and none of them exactly.
 */
const PASSPORT_TYPES = new Map([
  ['p', 'P - Popular Passport'],
  ['ordinary passport', 'P - Popular Passport'],
  ['popular passport', 'P - Popular Passport'],
  ['d', 'D - Diplomatic Passport'],
  ['diplomatic passport', 'D - Diplomatic Passport'],
  ['o', 'O - Official Passport'],
  ['official passport', 'O - Official Passport'],
]);

/** What this site calls the kind of passport the application recorded. */
export function passportTypeAsNamedHere(type) {
  if (!type) {
    return null;
  }
  return PASSPORT_TYPES.get(String(type).trim().toLowerCase()) ?? type;
}

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

/**
 * The dialling codes this bot's travellers use, longest first.
 *
 * Only enough to split the numbers that actually arrive. Longest first is
 * what makes the split right: +1 is a prefix of nothing here, but a list read
 * shortest-first would take the 9 off +995 and call Georgia something else.
 *
 * Kazakhstan is absent on purpose. It shares +7 with Russia and the site's
 * own list offers one entry for the pair, so there is nothing to tell apart.
 */
const DIALLING_CODES = [
  '998',
  '996',
  '995',
  '994',
  '992',
  '380',
  '375',
  '84',
  '7',
  '1',
];

/**
 * Splits a phone number into its dialling code and the rest.
 *
 * The site asks for the two separately, and the traveller types one thing:
 * "+7 912 345 67 89". Typed whole into the number field, the code goes in
 * twice and the site refuses it.
 */
export function splitPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) {
    return { phoneCountryCode: null, phone: null };
  }
  // Without a "+" there is no code to find: a number given bare is a local
  // one, and guessing a country for it would put a stranger's number on a
  // declaration.
  if (!/^\s*\+/.test(String(phone))) {
    return { phoneCountryCode: null, phone: digits };
  }
  for (const code of DIALLING_CODES) {
    if (digits.startsWith(code) && digits.length > code.length) {
      return { phoneCountryCode: code, phone: digits.slice(code.length) };
    }
  }
  return { phoneCountryCode: null, phone: digits };
}

/** A DD/MM/YYYY date as a day, or null when it is not one. */
function dayFrom(text) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(text ?? '').trim());
  if (!match) {
    return null;
  }
  return Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
}

/** How long the passport must outlast the visa, in days. */
export const PASSPORT_MARGIN_DAYS = 30;

/**
 * The visa number as this site wants it: the digits, without the suffix.
 *
 * A granted e-visa prints its number as "712345678/EV" on the Số / No. line,
 * and that is how the visa itself is read and stored. This form takes nine
 * digits and refuses anything else, so the suffix comes off here, where the
 * two spellings meet, and the record keeps the number as the visa prints it.
 */
export function visaNumberAsNamedHere(visaNumber) {
  const said = String(visaNumber ?? '').trim();
  if (!said) {
    return null;
  }
  const digits = /^(\d+)\s*\/\s*EV$/i.exec(said);
  return digits ? digits[1] : said;
}

/**
 * What this site will refuse, checked before it is typed.
 *
 * The rules are the site's own and it states them only in red under a field,
 * on a page the traveller is not looking at. Read here, a value the site will
 * not take is named in the chat along with everything else wanted, and the
 * traveller learns which field "Invalid visa number" is about.
 */
export function whatThisSiteWillRefuse(applicant = {}) {
  const refused = [];
  // The help behind the (?) beside the field: "The E-Visa number must be
  // numeric and 9 digits long." A granted visa prints "712345678/EV", so the
  // suffix is dropped for this site and the digits are what is judged.
  const visaNumber = visaNumberAsNamedHere(applicant.visaNumber);
  if (
    visaNumber &&
    /e-?visa/i.test(applicant.visaType ?? '') &&
    !/^\d{9}$/.test(visaNumber)
  ) {
    refused.push({ key: 'visaNumber', why: 'nineDigits' });
  }
  // "An electronic visa must expire at least 30 days before the passport
  // expires." A passport running out too soon is a trip to renew it, not a
  // value to correct, so it is worth saying early.
  const visaEnds = dayFrom(applicant.visaExpiryDate);
  const passportEnds = dayFrom(applicant.passportExpiryDate);
  if (visaEnds && passportEnds) {
    const days = (passportEnds - visaEnds) / 86400000;
    if (days < PASSPORT_MARGIN_DAYS) {
      refused.push({ key: 'passportExpiryDate', why: 'tooCloseToVisa', days });
    }
  }
  return refused;
}

/**
 * A value in the words this site uses for it.
 *
 * The application form and this one describe the same facts differently, and
 * a value that matches no option is refused outright, so the two fields whose
 * wording differs are translated on the way in.
 */
export function valueAsNamedHere(field, applicant = {}) {
  if (field.key === 'nationality') {
    return nationalityAsNamedHere(applicant.nationality);
  }
  if (field.key === 'passportType') {
    return passportTypeAsNamedHere(applicant.passportType);
  }
  if (field.key === 'visaNumber') {
    return visaNumberAsNamedHere(applicant.visaNumber);
  }
  return applicant[field.key];
}

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
  // A required field's label ends in the asterisk that marks it, inside the
  // same element as the words, so an exact match on the words alone finds
  // "Surname" and never "Given Name *".
  return page
    .getByLabel(new RegExp(`^\\s*${field.label}\\s*\\*?\\s*$`))
    .first();
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
  // Clearing is done from the keyboard, not by fill(''). A field this form
  // has already put a value in keeps it through fill(), and the typing that
  // follows lands on the end of what was there: a passport number typed
  // twice reads as both at once.
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.press('Backspace');
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
  // The site expires a declaration after a while and says so in a native
  // alert. Nothing dismisses one of those on a driven page, so the browser
  // stops answering entirely and the fill hangs with no error to report.
  // Taking the dialog here turns that into an expiry the caller can see.
  page.on('dialog', (dialog) => {
    page.expired = dialog.message();
    dialog.accept().catch(() => {});
  });
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
 * The captcha picture, as bytes.
 *
 * The element is drawn before its picture arrives, so the wait is for a data
 * URL on it, not for the element itself. This site marks the image
 * `alt="captcha"`
 * and the visa form marks it `alt="captcha img"`, so each site needs its own
 * reader.
 */
/* global document */
export async function readCaptchaImage(page) {
  await page
    .waitForFunction(
      () =>
        /^data:image\//.test(
          document.querySelector('[role=dialog] img')?.src ?? ''
        ),
      undefined,
      { timeout: 15000 }
    )
    .catch(() => {});
  const src = await page.evaluate(
    () => document.querySelector('[role=dialog] img')?.src ?? null
  );
  const match = src && /^data:image\/\w+;base64,\s*(.+)$/s.exec(src);
  return match ? Buffer.from(match[1], 'base64') : null;
}

/** Asks the site for another picture, when one cannot be read. */
export async function refreshCaptchaImage(page) {
  await page
    .getByRole('button', { name: 'Reload CAPTCHA' })
    .click()
    .catch(() => {});
  await page.waitForTimeout(700);
  return readCaptchaImage(page);
}

/**
 * How many characters the site's captcha has, which is how a reading is
 * judged plausible before it is tried.
 */
export const CAPTCHA_LENGTHS = [4, 5];

/**
 * Reads a captcha picture, by agreement between several treatments of it.
 *
 * No single pass is reliable: the picture carries a line through it, and the
 * treatments that erase the line also erase thin strokes. Reading it several
 * ways and taking what most of them say is steadier than any one, and a
 * reading of the wrong length is discarded before it is counted, since the
 * site's codes are four or five characters.
 *
 * Returns the best reading and how many ways agreed on it, so a caller can
 * decide whether to try it or ask a person.
 */
export function readCaptchaText(img, tools) {
  const { upscale, grayscale, binarize, ocrCanvas } = tools;
  const votes = new Map();
  for (const scale of [3, 5]) {
    for (const make of [
      () => upscale(img, scale),
      () => grayscale(upscale(img, scale)),
      () => binarize(grayscale(upscale(img, scale)), 160),
    ]) {
      for (const psm of [7, 8, 13]) {
        let said = '';
        try {
          said = ocrCanvas(make(), {
            psm,
            config: {
              tessedit_char_whitelist:
                'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
            },
          });
        } catch {
          continue;
        }
        const clean = said.replace(/[^A-Za-z0-9]/g, '');
        if (!CAPTCHA_LENGTHS.includes(clean.length)) {
          continue;
        }
        votes.set(clean, (votes.get(clean) ?? 0) + 1);
      }
    }
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [best, agreed] = ranked[0] ?? [null, 0];
  return { code: best, agreed, votes: ranked };
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

/**
 * Ticks the box saying the visa notes have been read.
 *
 * The site refuses the visa section until it is ticked — "Please check this
 * box to continue" — and the box carries neither a name nor an id, so its own
 * words are the only handle on it. The notes it acknowledges say what the
 * traveller is declaring, and the traveller is the one who sends the form, so
 * ticking it here states nothing they do not go on to confirm.
 */
export async function acknowledgeVisaNotes(page) {
  const box = page.getByRole('checkbox').first();
  // No box drawn is not a box that refused: the site draws none until a
  // nationality is chosen, and there is nothing to report about it.
  if (!(await box.isVisible().catch(() => false))) {
    return null;
  }
  if (await box.isChecked().catch(() => false)) {
    return true;
  }
  // The label carries the click on this form; the input under it is the thing
  // React watches, so checking it directly is what makes the error go.
  await box.check({ force: true }).catch(() => {});
  return box.isChecked().catch(() => false);
}

/**
 * The dialling code, which is its own field beside the phone number.
 *
 * The site fills it from the nationality — a Russian passport gets (+7) — so
 * this only has to correct a traveller whose telephone is somewhere else.
 * A number typed without its code reaches nobody.
 */
export async function choosePhoneCountryCode(page, code, at = 0) {
  const digits = String(code ?? '').replace(/\D/g, '');
  if (!digits) {
    return null;
  }
  const input = page.locator(`[name="${at}_phoneCountryCode"]`).first();
  if (!(await input.isVisible().catch(() => false))) {
    return null;
  }
  if (
    (await input.inputValue().catch(() => '')).replace(/\D/g, '') === digits
  ) {
    return `(+${digits})`;
  }
  await chooseFrom(page, input, `(+${digits})`, 'phoneCountryCode');
  return `(+${digits})`;
}

/**
 * Picks a gender, which the site asks for as radio buttons.
 *
 * The tick is read back before this returns. A radio that will not take a
 * click leaves the page looking filled while the one required answer on it is
 * blank, and a declaration is refused at the end for a field nobody was told
 * about.
 */
export async function chooseGender(page, sex) {
  const said = String(sex ?? '').toLowerCase();
  const wanted = said.startsWith('f')
    ? 'Female'
    : said.startsWith('o')
      ? 'Other'
      : 'Male';
  const radio = page.getByRole('radio', { name: wanted, exact: true }).first();
  await radio.waitFor({ state: 'attached', timeout: 20000 });
  // Material UI draws its own circle over the input and leaves the input
  // itself zero-sized, so a plain click lands on the decoration and a plain
  // check calls the input invisible. The force goes to the input underneath.
  await radio.check({ force: true });
  if (!(await radio.isChecked())) {
    throw new Error(`${wanted} would not tick`);
  }
  return wanted;
}

/**
 * The controls that are not text: the date, the picture, the gender, the
 * dialling code and the box that unlocks the visa section.
 *
 * Each is answered its own way — a button among three, a file, a radio, a
 * list, a tick — so they are done together, ahead of the typing.
 *
 * The arrival date is settled first. A day the site will not offer ends the
 * fill, and nothing should be ticked or typed on a declaration that is about
 * to be abandoned. Everything after it assumes a form worth filling.
 */
async function fillTheRest(
  page,
  applicant,
  { passportImage, filled, failed, at = 0 }
) {
  if (applicant.arrivalDate) {
    const picked = await chooseArrivalDate(page, applicant.arrivalDate);
    if (picked.tooEarly) {
      return picked;
    }
    filled.push('arrivalDate');
  }
  // Until this is ticked the site holds the visa fields behind an error and
  // refuses everything typed into them, so it comes before the typing. A box
  // that will not tick is reported, not thrown: the rest of the form is still
  // worth filling, and the traveller can tick one box themselves.
  await acknowledgeVisaNotes(page)
    .then((ticked) => {
      if (ticked === true) {
        filled.push('readTheNotes');
      } else if (ticked === false) {
        failed.push('readTheNotes: the box would not tick');
      }
    })
    .catch((error) => failed.push(`readTheNotes: ${error.message}`));
  if (applicant.phoneCountryCode) {
    await choosePhoneCountryCode(page, applicant.phoneCountryCode, at)
      .then(() => filled.push('phoneCountryCode'))
      .catch((error) => failed.push(`phoneCountryCode: ${error.message}`));
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
    await chooseGender(page, applicant.sex)
      .then(() => filled.push('sex'))
      .catch((error) => failed.push(`sex: ${error.message}`));
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
  given = {},
  { at = 0, passportImage = null } = {}
) {
  const filled = [];
  const missing = [];
  const failed = [];

  // The traveller gives one phone number and the site wants two fields of it.
  // The split belongs here, on this site's doorstep: the record goes on
  // holding the number whole, which is what every other form asks for.
  const split = splitPhone(given.phone);
  const applicant = {
    ...given,
    ...(split.phone ? split : {}),
  };

  const tooEarly = await fillTheRest(page, applicant, {
    passportImage,
    filled,
    failed,
    at,
  });
  if (tooEarly) {
    return { filled, missing, failed, arrival: tooEarly };
  }

  for (const field of FORM_FIELDS) {
    const value = valueAsNamedHere(field, applicant);
    if (value === null || value === undefined || value === '') {
      missing.push(field.key);
      continue;
    }
    const input = inputFor(page, field, at);
    // A locked field cannot be typed into, so what matters is whether the site
    // has already put the right thing in it. The nationality is chosen a step
    // earlier and locked holding that choice, which is filled; the issuing
    // place is locked empty until the visa type is set, and calling that
    // filled reported a blank field as done.
    if (await input.isDisabled().catch(() => false)) {
      const already = await input.inputValue().catch(() => '');
      if (already) {
        filled.push(field.key);
      } else {
        failed.push(`${field.key}: locked and empty`);
      }
      continue;
    }
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

  // An expiry caught mid-fill makes everything typed after it meaningless:
  // the page is still drawn, but the site has forgotten the declaration.
  return {
    filled,
    missing,
    failed,
    arrival: null,
    expired: page.expired,
    // Typed and on the page, but the site will not take it. Saying so is the
    // whole point: the traveller cannot see the red text under the field.
    refused: whatThisSiteWillRefuse(applicant),
  };
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
