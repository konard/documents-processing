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
import { saidBriefly } from './evisa-messages.mjs';
import {
  attachBrowserFeatures,
  checkpointBrowser,
} from './evisa-browser-features.mjs';

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

/**
 * How long to wait for a field the site should have drawn, in milliseconds.
 *
 * Generous, because this form draws itself in pieces as the values above each
 * field are settled, and a field arriving late is normal.
 */
export const FIELD_TIMEOUT_MS = 20000;

/**
 * How long to wait for a field where the form is known not to be there.
 *
 * A declaration whose nationality never took has no fields at all behind it,
 * since the site draws none until one is chosen. The full wait for each of
 * them costs a minute to learn the same thing three times over. The first
 * timeout is the evidence; the rest are asked for briefly.
 */
export const GONE_TIMEOUT_MS = 1000;

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
  // The declaration is described to the traveller in its own words — one Full
  // Name, a Gender — because that is how the filed copy prints. This form
  // asks for the two halves of the name separately and calls the gender
  // "sex", so a record holding only the described shape left the name and the
  // one required radio blank on a page that reported itself full.
  if (field.key === 'surname' || field.key === 'givenName') {
    return applicant[field.key] ?? halfOfName(applicant.fullName, field.key);
  }
  if (field.key === 'sex') {
    return applicant.sex ?? applicant.gender;
  }
  return applicant[field.key];
}

/**
 * One half of a name written surname first, as the declaration writes it.
 *
 * The surname is the first word and the given name is the rest: "TRAVELLER
 * JOHN ALEX" is TRAVELLER and JOHN ALEX. A name of one word gives a surname
 * and no given name, and the form is left to object to that: a guess here
 * would put an invented name on a government declaration.
 */
export function halfOfName(fullName, half) {
  const words = String(fullName ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) {
    return null;
  }
  const [first, ...rest] = words;
  return half === 'surname' ? first : rest.join(' ') || null;
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
export async function typeInto(
  input,
  value,
  named = 'the field',
  { timeout = FIELD_TIMEOUT_MS } = {}
) {
  await input.waitFor({ state: 'visible', timeout });
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
 *
 * `sameIf` is for a list where several options are the same answer: every
 * country sharing a dialling code puts that same code in the field. Where the
 * caller can say two options are interchangeable and they all are, the first
 * is taken. It does not loosen the refusal anywhere it is not passed.
 */
export async function chooseFrom(
  page,
  input,
  value,
  named = 'the field',
  { timeout = FIELD_TIMEOUT_MS, sameIf = null } = {}
) {
  await input.waitFor({ state: 'visible', timeout });
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
    // Several options can be the same answer: the countries sharing a
    // dialling code all put that code in the field. Where the caller says so,
    // and they agree, the first is as good as any. Without that, an ambiguous
    // match is refused: guessing at somebody's nationality is not safe.
    const agree =
      sameIf && holding.length > 1 && holding.every(({ t }) => sameIf(t));
    if (holding.length !== 1 && !agree) {
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
  downloadsPath = null,
  traceOutput = null,
  onTraceCheckpoint = null,
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
  const browser = await chromium.launch({
    headless,
    args,
    ...(downloadsPath ? { downloadsPath } : {}),
  });
  const context = await browser.newContext(
    viewport ? { viewport } : { viewport: null }
  );
  const page = await context.newPage();
  const features = await attachBrowserFeatures(page, {
    downloadsDirectory: downloadsPath,
    traceOutput,
    onCheckpoint: onTraceCheckpoint,
  });
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
  await checkpointBrowser(page, 'prearrival-opened', {
    actor: 'site',
    reason: 'initial',
  });
  if (!headless) {
    await giveBackTheFront(wasInFront);
  }
  return { browser, context, page, ...features };
}

/** Whether the captcha dialog is up, which is how the site opens. */
export function captchaIsUp(page) {
  return Promise.resolve()
    .then(() => page.locator('[role=dialog]:has-text("CAPTCHA")').isVisible())
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
export async function readCaptchaImage(page) {
  // The wait ends on either answer the site can give: a picture, or its own
  // word that there will not be one. Waiting the full timeout for a page that
  // has already given up spends fifteen seconds to learn what it printed in
  // the first of them.
  //
  // "CAPTCHA is unavailable" alone is not that word: the site prints it as
  // the placeholder in the empty box while the picture is still coming, so
  // every ordinary load says it for about half a second. Only "Failed to get
  // CAPTCHA" marks a request that actually failed.
  await page
    .waitForFunction(
      () => {
        const dialog = document.querySelector('[role=dialog]');
        if (!dialog) {
          return false;
        }
        if (/Failed to get CAPTCHA/i.test(dialog.innerText ?? '')) {
          return true;
        }
        return /^data:image\//.test(dialog.querySelector('img')?.src ?? '');
      },
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
 * How long to wait for the site's answer to a submitted captcha code.
 *
 * Both answers arrive well inside this: the dialog closes, or the picture is
 * redrawn. It is the bound for a site that gives neither.
 */
export const CAPTCHA_ANSWER_MS = 15000;

/**
 * Types a captcha code and verifies it.
 *
 * Returns whether the dialog went away, which is the site's only answer: a
 * wrong code leaves it up, with a fresh picture to read.
 *
 * The site says no by redrawing the picture inside the dialog it keeps up, so
 * waiting for the dialog to detach waits the whole timeout on every wrong
 * code. Watching for either answer — gone, or a different picture — costs a
 * refusal the round trip and nothing more, which is what makes trying several
 * pictures cheap enough to be worth doing.
 */
export async function answerCaptcha(page, code) {
  const dialog = page.locator('[role=dialog]');
  const before = await pictureNow(page);
  await dialog.locator('input').fill(String(code).trim());
  await dialog.getByRole('button', { name: 'Verify' }).click();
  await page
    .waitForFunction(
      (was) => {
        const img = document.querySelector('[role=dialog] img');
        return !img || (img.src ?? '') !== was;
      },
      before,
      { timeout: CAPTCHA_ANSWER_MS }
    )
    .catch(() => {});
  return !(await captchaIsUp(page));
}

/** The captcha picture's source as it stands, for telling a redraw from a pass. */
function pictureNow(page) {
  return page
    .evaluate(() => document.querySelector('[role=dialog] img')?.src ?? '')
    .catch(() => '');
}

/**
 * Chooses the nationality and moves on to the form itself.
 *
 * The site asks for it alone on the first step, then carries it in the URL,
 * so this is the one step that decides which form is drawn.
 */
export async function chooseNationality(page, nationality) {
  const named = nationalityAsNamedHere(nationality);
  // Nothing known to type. The nationality gates every field behind it: the
  // site draws no form until one is chosen, so name the cause here. Typing a
  // blank would fail a moment later with an error about types, not about data.
  if (!named) {
    throw new Error('no nationality to choose: the record has none');
  }
  const box = page.locator('input[name="nationality"]');
  await box.waitFor({ state: 'visible', timeout: 20000 });
  await box.fill('');
  await box.type(named, { delay: 30 });
  const option = page.locator('[role=option]').first();
  await option.waitFor({ state: 'visible', timeout: 10000 });
  await option.click();
  await page.getByRole('button', { name: 'Next' }).click();
  // A fresh CAPTCHA can intercept this Next just as it can intercept either
  // page transition later. Stop waiting as soon as either outcome is drawn;
  // the caller handles the dialog without taking a covered-page screenshot.
  await Promise.race([
    page.waitForURL(/\/foreign\?nat=/, { timeout: 20000 }),
    page
      .locator('[role=dialog]:has-text("CAPTCHA")')
      .waitFor({ state: 'visible', timeout: 20000 }),
  ]);
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
  await chooseFrom(page, input, `(+${digits})`, 'phoneCountryCode', {
    // Several countries share a dialling code, and the list names each one
    // separately: "(+1)" is offered as United States, Canada and Dominican
    // Republic. Any of them puts the same code in the field, which is all
    // this field holds, so the first is taken where they agree on the code.
    sameIf: (text) => codeIn(text) === digits,
  });
  const chosen = await input.inputValue().catch(() => '');
  if (chosen.replace(/\D/g, '') !== digits) {
    throw new Error(`phoneCountryCode shows "${chosen}", not "(+${digits})"`);
  }
  return chosen;
}

/**
 * The one dialling code an option names, as digits, or null.
 *
 * A row naming two is not one answer, whatever the first of them says, so it
 * is refused the way any other ambiguity is.
 */
function codeIn(text) {
  const found = String(text ?? '').match(/\(\+(\d+)\)/g) ?? [];
  return found.length === 1 ? found[0].replace(/\D/g, '') : null;
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
  // A control the site has locked is not one to force. Dispatching a click at
  // a disabled input does set `checked`, which would report a gender the form
  // has not got, so it is asked about before anything is tried.
  if (await radio.isDisabled().catch(() => false)) {
    throw new Error(`${wanted} is disabled on this form`);
  }

  // Material UI draws its own circle over the input and leaves the input
  // itself zero-sized, so a plain click lands on the decoration and a plain
  // check calls the input invisible. Three ways in, because the one that
  // works depends on where this control keeps its state: the input itself,
  // the label MUI hangs its handler on, or React, which re-renders from its
  // own state and puts a directly-clicked input back the way it was.
  const ways = [
    // The input under the circle, which is what `check` aims at. This is the
    // one that reported "Clicking the checkbox did not change its state".
    () => radio.check({ force: true, timeout: 5000 }),
    // The label. MUI wires the handler here, so a click on it goes through
    // React and the state it re-renders from is the state that changes.
    () => labelOf(page, radio, wanted).click({ timeout: 5000 }),
    // The event on its own, for a control that listens without being
    // clickable: nothing is scrolled, nothing is aimed at.
    () => radio.dispatchEvent('click'),
  ];

  let last = null;
  for (const way of ways) {
    await way().catch((error) => {
      last = error;
    });
    // Read back from the page, not from what the click returned. A control
    // that swallows the click leaves the page looking filled while the one
    // required answer on it is blank, and the declaration is refused at the
    // end for a field nobody was told about.
    if (await radio.isChecked().catch(() => false)) {
      return wanted;
    }
  }
  throw new Error(
    `${wanted} would not tick${last ? `: ${saidBriefly(last)}` : ''}`
  );
}

/**
 * The label that belongs to a radio, for a click that goes through MUI.
 *
 * The input's own label where it has one, and the row of the group carrying
 * the word otherwise, since the site does not label every one the same way.
 */
function labelOf(page, radio, wanted) {
  return radio
    .locator('xpath=ancestor::label[1]')
    .or(page.getByText(wanted, { exact: true }))
    .first();
}

/**
 * The fields the site fills by itself from an uploaded passport.
 *
 * Measured against the live site: a data page with a machine-readable zone
 * comes back as these five. The passport type and nationality are not among
 * them — those are already set before the upload, so seeing them says nothing
 * about whether the picture was read.
 */
const READ_FROM_PASSPORT = [
  'passportNumber',
  'passportExpiryDate',
  'surname',
  'givenName',
  'dateOfBirth',
];

/** How long to give the site's own reading of an uploaded passport. */
export const PASSPORT_READ_MS = 30000;

/**
 * True when a value read off the page is the site's hint, not a reading.
 *
 * An empty date input on this form gives back "DD/MM/YYYY": the format it
 * wants typed, not a value it holds. Taken for a value it ends the wait for
 * the site's reading early, and then stands in the disagreement report as a
 * difference of opinion about a date.
 */
function isAPlaceholder(value) {
  return /^[DMY]{1,4}([/-][DMY]{1,4})+$/i.test(value);
}

/**
 * Puts the passport on the page and waits for the site to read it.
 *
 * The site uploads the picture, reads it on its own server and fills what it
 * finds. Measured on the live site, the fields land between half a second and
 * three seconds after the file goes up — so a fixed sleep is a coin toss. Too
 * short and the reading is taken from a page the site has not filled yet,
 * which is worse than not taking it: the comparison that is supposed to catch
 * a misread passport instead finds an empty page and agrees with everything.
 *
 * So this waits for the values themselves, and returns as soon as any of them
 * appears. `took` says whether the site read anything at all, which is the
 * only honest evidence that the upload did more than attach a file.
 */
export async function uploadPassport(page, passportImage, at = 0) {
  await page.setInputFiles('input[name="passportImage"]', passportImage);
  // Only the fields the site addresses by name can be watched this way. The
  // surname and given name are found by their label instead, and the five
  // below are enough to tell a reading from an empty page.
  const watched = FORM_FIELDS.filter(
    (field) => field.name && READ_FROM_PASSPORT.includes(field.key)
  ).map((field) => selectorFor(field, at));
  await page
    .waitForFunction(
      (where) =>
        where.some((one) => {
          const value = document.querySelector(one)?.value?.trim();
          // An empty date field holds its own format hint, so waking on it
          // would end the wait before the site has read anything. The test is
          // written out again because this function is serialized into the
          // browser, where isAPlaceholder does not exist; the two are kept
          // together by the test that holds them to the same answer.
          return (
            Boolean(value) && !/^[DMY]{1,4}([/-][DMY]{1,4})+$/i.test(value)
          );
        }),
      watched,
      { timeout: PASSPORT_READ_MS }
    )
    // A site that reads nothing is an answer too, and the one the caller is
    // told about. It is not a reason to abandon the declaration.
    .catch(() => {});
  const site = await readDeclaration(page, at);
  // An empty date field reads back as its own format hint, so a page where
  // only those came back is a page the site read nothing from.
  const took = READ_FROM_PASSPORT.some((key) => {
    const value = String(site[key] ?? '').trim();
    return value && !isAPlaceholder(value);
  });
  return { took, site };
}

/**
 * The controls that are not text: the date, the picture, the gender and the
 * box that unlocks the visa section.
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
  { passportImage, filled, failed, read = {}, at = 0 }
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
    .catch((error) => failed.push(`readTheNotes: ${saidBriefly(error)}`));
  if (passportImage) {
    await uploadPassport(page, passportImage, at)
      .then(({ took, site }) => {
        filled.push('passportImage');
        // What the site made of the picture, taken before anything is typed
        // over it. Two readings of one passport that disagree mean one of them
        // is wrong, and the traveller is the only one who can say which.
        read.site = site;
        if (!took) {
          // The file went up and the site filled nothing from it. The
          // declaration is still worth filling — the bot's own reading of the
          // passport is what goes in — but there is no second opinion to check
          // it against, and saying so beats a silent comparison against an
          // empty page that agrees with everything.
          failed.push('passportImage: the site read nothing from it');
        }
      })
      .catch((error) => failed.push(`passportImage: ${saidBriefly(error)}`));
  }
  const sex = applicant.sex ?? applicant.gender;
  if (sex) {
    await chooseGender(page, sex)
      .then(() => filled.push('sex'))
      .catch((error) => failed.push(`sex: ${saidBriefly(error)}`));
  }
  return null;
}

/**
 * Makes the dialling code the last write on a passenger page.
 *
 * The passport reader redraws this control after the upload starts, so a
 * selection made with the other special controls can disappear underneath
 * the rest of the fill.
 */
async function finishPhoneCountryCode(page, applicant, { at, filled, failed }) {
  if (!applicant.phoneCountryCode) {
    return;
  }
  try {
    const chosen = await choosePhoneCountryCode(
      page,
      applicant.phoneCountryCode,
      at
    );
    if (!chosen) {
      throw new Error('the control is not visible');
    }
    filled.push('phoneCountryCode');
  } catch (error) {
    failed.push(`phoneCountryCode: ${saidBriefly(error)}`);
  }
}

/**
 * Puts one value in one field, saying what became of it.
 *
 * `drawn` says whether the form is believed to be there. Where it is not, the
 * wait is short: the answer is the same and comes sixty times sooner.
 */
async function putOneIn(page, field, value, { at, drawn }) {
  const input = inputFor(page, field, at);
  // A locked field cannot be typed into, so what matters is whether the site
  // has already put the right thing in it. The nationality is chosen a step
  // earlier and locked holding that choice, which is filled; the issuing
  // place is locked empty until the visa type is set, and calling that
  // filled reported a blank field as done.
  if (await input.isDisabled().catch(() => false)) {
    const already = await input.inputValue().catch(() => '');
    return already
      ? { ok: true }
      : { ok: false, why: 'locked and empty', absent: false };
  }
  const waiting = { timeout: drawn ? FIELD_TIMEOUT_MS : GONE_TIMEOUT_MS };
  try {
    // A date here is a plain DD/MM/YYYY text field, not the readonly picker
    // the visa form uses, so it is typed like any other text.
    if (field.how === 'select') {
      await chooseFrom(page, input, value, field.key, waiting);
    } else {
      await typeInto(input, value, field.key, waiting);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      why: saidBriefly(error),
      absent: isMissingFromPage(error),
    };
  }
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
  // Whether the site has drawn the form at all. Assumed until a field that
  // should be there is not.
  let drawn = true;

  // The traveller gives one phone number and the site wants two fields of it.
  // The split belongs here, on this site's doorstep: the record goes on
  // holding the number whole, which is what every other form asks for.
  const split = splitPhone(given.phone);
  const applicant = {
    ...given,
    ...(split.phone ? split : {}),
  };

  // What the site itself read off the uploaded passport, kept so the values
  // typed after it can be held up against it.
  const read = {};

  const tooEarly = await fillTheRest(page, applicant, {
    passportImage,
    filled,
    failed,
    read,
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
    const went = await putOneIn(page, field, value, { at, drawn });
    if (went.ok) {
      filled.push(field.key);
      // Something was there to take it, so the form is drawn after all and
      // the fields after this one are worth the full wait again.
      drawn = true;
      continue;
    }
    failed.push(`${field.key}: ${went.why}`);
    // Nothing has gone in yet and this one was not even drawn. The site draws
    // no field until the nationality is chosen, so the rest are almost
    // certainly absent too: ask briefly and report them together.
    if (!filled.length && went.absent) {
      drawn = false;
    }
  }

  // The passport scan updates the page asynchronously and can redraw the
  // Country Code control after a choice made near the start. The live form
  // then looked filled but refused Next because the selection had vanished.
  // Make this the final write on the passenger page and read it back before
  // claiming it survived.
  await finishPhoneCountryCode(page, applicant, { at, filled, failed });

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
    // Where the site's own reading of the passport and the bot's disagree.
    disagreed: read.site ? whatTheReadingsDisagreeOn(read.site, applicant) : [],
  };
}

/**
 * The fields where the site read the passport differently from the bot.
 *
 * Both read the same picture: the site on upload, the bot when the traveller
 * sent it. Agreement is a passport read twice and understood the same way,
 * and a field where they differ is one of the two being wrong — which the
 * traveller is the only one able to settle. The bot's value is what goes on
 * the form either way, since it is the one checked against every other
 * document; the disagreement is reported, not acted on.
 */
export function whatTheReadingsDisagreeOn(fromSite, applicant) {
  const differs = [];
  for (const field of PASSPORT_FIELDS) {
    const theirs = String(fromSite[field] ?? '').trim();
    const ours = String(
      valueAsNamedHere({ key: field }, applicant) ?? ''
    ).trim();
    // Only a field both of them read says anything. One side blank is a
    // reading that was not attempted, not a reading that disagrees. An empty
    // date field reads back as its own format hint, and reporting "the site
    // says DD/MM/YYYY and I say 01/01/2030" as a disagreement is noise that
    // teaches the traveller to skip the part of the message that matters.
    if (!theirs || !ours || isAPlaceholder(theirs)) {
      continue;
    }
    if (theirs.toUpperCase() !== ours.toUpperCase()) {
      differs.push({ key: field, site: theirs, bot: ours });
    }
  }
  return differs;
}

/**
 * The fields the site fills in for itself from an uploaded passport.
 *
 * These are the ones worth comparing: anything else on the form comes from
 * the visa or the ticket, which the picture of a passport says nothing about.
 */
export const PASSPORT_FIELDS = [
  'passportNumber',
  'passportType',
  'passportExpiryDate',
  'surname',
  'givenName',
  'dateOfBirth',
  'sex',
];

/**
 * True when a failure says the element was never there.
 *
 * A timeout waiting for a field to become visible is the site not having
 * drawn it. Anything else — a value that would not take, a list with no
 * matching option — is about a field that does exist, and says nothing about
 * the rest of the form.
 */
export function isMissingFromPage(error) {
  return /Timeout .* exceeded/i.test(String(error?.message ?? error));
}

/**
 * Photographs the whole declaration, with the site's floating bar out of it.
 *
 * The page carries a sticky header that follows the viewport down. A full-page
 * picture draws it where the viewport stands, so it lands across the middle of
 * the form and covers a row of it — on a real fill, the passport type and
 * number. Pinning it to the top for the length of the exposure puts it back
 * where a traveller scrolling the page sees it, above everything, hiding
 * nothing. The page is left as it was found, since it is still the form the
 * traveller is about to send.
 */
export async function photographDeclaration(page) {
  // A focused Material UI input keeps its orange focus underline. That is
  // useful while typing, but misleading in the evidence photo: it makes the
  // last filled control look invalid. Blur it without changing any value.
  await page
    .evaluate(() => {
      const active = document.activeElement;
      if (typeof active?.blur === 'function') {
        active.blur();
      }
    })
    .catch(() => {});
  // The focus underline has a 250 ms CSS transition; expose only after it
  // reaches the unfocused state.
  await page.waitForTimeout?.(250);
  const pinned = await page
    .evaluate(() => {
      const bar = document.querySelector('header');
      if (!bar || getComputedStyle(bar).position !== 'sticky') {
        return false;
      }
      bar.dataset.wasPositioned = bar.style.position;
      bar.style.position = 'absolute';
      bar.style.top = '0';
      return true;
    })
    .catch(() => false);
  try {
    return await page.screenshot({ fullPage: true });
  } finally {
    if (pinned) {
      await page
        .evaluate(() => {
          const bar = document.querySelector('header');
          if (!bar) {
            return;
          }
          bar.style.position = bar.dataset.wasPositioned ?? '';
          bar.style.top = '';
          delete bar.dataset.wasPositioned;
        })
        .catch(() => {});
    }
  }
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
  const phoneCountryCode = await page
    .locator(`[name="${at}_phoneCountryCode"]`)
    .first()
    .inputValue()
    .catch(() => null);
  if (phoneCountryCode) {
    values.phoneCountryCode = phoneCountryCode;
  }
  const fullName = [values.surname, values.givenName].filter(Boolean).join(' ');
  if (fullName) {
    values.fullName = fullName;
  }
  for (const gender of ['Male', 'Female', 'Other']) {
    const checked = await choiceIsChecked(page, gender);
    if (checked) {
      values.gender = gender;
      break;
    }
  }
  const arrivalDate = await selectedArrivalDate(page);
  if (arrivalDate) {
    values.arrivalDate = arrivalDate;
  }
  if (values.phone && phoneCountryCode) {
    const code = phoneCountryCode.replace(/\D/g, '');
    const local = values.phone.replace(/\D/g, '');
    if (code && local) {
      values.phone = `+${code}${local}`;
    }
  }
  return values;
}

/** The date button visibly selected on the passenger page. */
async function selectedArrivalDate(page) {
  try {
    for (const date of await offeredArrivalDates(page)) {
      const button = page.getByRole('button', { name: date, exact: true });
      const attributes = await Promise.all(
        ['aria-pressed', 'aria-selected', 'data-selected', 'class'].map(
          (name) => button.getAttribute(name).catch(() => null)
        )
      );
      if (
        attributes
          .slice(0, 3)
          .some((value) => /^(?:true|selected)$/i.test(value)) ||
        /Mui-selected|MuiButton-contained/.test(attributes[3] ?? '')
      ) {
        return date;
      }
    }
  } catch {
    // A partial page double, or a page being redrawn, can have no date
    // buttons. That means no date was read, not that the whole read failed.
  }
  return null;
}

/** Whether one of the passenger's radios is selected, tolerating no radio. */
async function choiceIsChecked(page, name) {
  try {
    return await page
      .getByRole('radio', { name, exact: true })
      .first()
      .isChecked();
  } catch {
    return false;
  }
}
