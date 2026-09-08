// evisa-passport.mjs
//
// Reads applicant data off a passport data page and prepares the two images the
// e-visa form uploads. Field values come from the machine-readable zone, whose
// check digits let us tell a confident read from a guess.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  renderImage,
  regionCanvas,
  upscale,
  ocrCanvas,
  ocrData,
  rowsFromWords,
  keepBlack,
  grayscale,
  binarize,
} from './ocr-lib.mjs';
import { parseMrzLine1, parseMrzLine2 } from './mrz-lib.mjs';
import { PHOTO_RULES, countryName, sexLabel } from './evisa-schema.mjs';
import { normalizeName } from './evisa-data.mjs';
import { editDistance } from './translit.mjs';
import { isKnownPlace } from './evisa-home-address.mjs';

// The machine-readable zone is Latin-only by design, so an English-trained
// engine reads it whatever language the rest of the page is in. The printed
// side of a Russian passport is bilingual; the fields the zone leaves out (the
// issue date, the place of birth, the authority) are read off that side by
// readPassportPage, in Russian where a Russian model is installed.

/** The MRZ occupies the bottom ~11% of a TD3 passport data page. */
const MRZ_REGION = { x: 0, y: 0.883, w: 1, h: 0.112 };
const MRZ_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';

/**
 * Parses the two zone lines out of what a band read, and counts how many of
 * the second line's check digits hold.
 */
function parseMrzLines(candidates) {
  let line1 = null;
  let line2 = null;
  for (const line of candidates) {
    if (!line1 && /^P[A-Z<]/.test(line)) {
      line1 = parseMrzLine1(line);
    } else if (!line2) {
      line2 = parseMrzLine2(line);
    }
  }
  if (!line2) {
    return { line1, line2, score: 0 };
  }
  // A check digit that holds counts double; a value the parser had to repair
  // to make it hold counts against, since a repair can land on a wrong value
  // that happens to check. A first line found alongside is worth a little.
  const checks = [
    line2.passportCheckOk,
    line2.dobCheckOk,
    line2.expiryCheckOk,
  ].filter(Boolean).length;
  const score = checks * 2 - (line2.repaired?.length ?? 0) + (line1 ? 1 : 0);
  return { line1, line2, score };
}

/** The best score parseMrzLines can give: three clean checks and a first line. */
const MRZ_CLEAN_SCORE = 7;

/**
 * Reads the MRZ from a rendered passport page and converts it to schema fields.
 *
 * Every MRZ field carries a check digit. When one fails the value is still
 * returned, but listed in `unverified` so the caller can require review rather
 * than silently submitting a misread passport number.
 */
export async function readPassportMrz(imagePath) {
  const image = await renderImage(imagePath);

  // The MRZ sits at the bottom of a data page, and somewhere in the middle of a
  // photo of a whole passport. A few plausible bands are read in turn and the
  // first that parses is kept; a wrong band simply yields no MRZ.
  const bands = [
    MRZ_REGION,
    { x: 0, y: 0.86, w: 1, h: 0.14 },
    // A cut-out page puts the zone lower in the frame, and a slice that takes
    // in both lines with room above them reads cleaner than one that starts
    // inside the first line.
    { x: 0, y: 0.8, w: 1, h: 0.2 },
    { x: 0, y: 0.72, w: 1, h: 0.28 },
    { x: 0, y: 0.78, w: 1, h: 0.22 },
    { x: 0, y: 0.6, w: 1, h: 0.2 },
    { x: 0, y: 0.68, w: 1, h: 0.16 },
    { x: 0, y: 0.45, w: 1, h: 0.2 },
    { x: 0, y: 0, w: 1, h: 1 },
  ];

  // Every band that yields a second line is a candidate, and the one whose
  // check digits hold up best is kept: a band that clips the zone still
  // produces a line-shaped string, and its digits are then wrong in ways only
  // the check digits reveal. A band with all three intact ends the search.
  let best = null;
  for (const band of bands) {
    const canvas = upscale(regionCanvas(image, band), 3);
    const text = ocrCanvas(canvas, { whitelist: MRZ_WHITELIST, psm: 6 });
    const candidate = text
      .split('\n')
      .map((line) => line.replace(/\s/g, ''))
      .filter((line) => line.length > 25);
    const parsed = parseMrzLines(candidate);
    if (!parsed.line2) {
      continue;
    }
    if (!best || parsed.score > best.score) {
      best = parsed;
    }
    if (parsed.score === MRZ_CLEAN_SCORE) {
      break;
    }
  }

  if (!best) {
    return { data: {}, unverified: [], repaired: [], mrzFound: false };
  }
  const { line1, line2 } = best;

  const unverified = [];
  if (!line2.passportCheckOk) {
    unverified.push('passportNumber');
  }
  if (!line2.dobCheckOk) {
    unverified.push('dateOfBirth');
  }
  if (!line2.expiryCheckOk) {
    unverified.push('passportExpiryDate');
  }

  const data = {
    passportNumber: line2.passportNumber,
    dateOfBirth: line2.dob,
    passportExpiryDate: line2.expiry,
    nationality: countryName(line2.nationality),
    sex: sexLabel(line2.sex),
  };
  if (line1) {
    // From OCR, so a digit in a name is a misread and is mapped back.
    data.surname = normalizeName(line1.surname, { fromOcr: true });
    data.givenName = normalizeName(line1.given, { fromOcr: true });
  }

  for (const key of Object.keys(data)) {
    if (!data[key]) {
      delete data[key];
    }
  }

  // Fields the check digit had to correct, so a caller can surface them for a
  // second look even though they now validate.
  return { data, unverified, repaired: line2.repaired ?? [], mrzFound: true };
}

/**
 * Cut-offs for the black-ink layer of a page. The printed values are black and
 * the security pattern behind them is coloured, but how dark the print comes
 * out varies from photo to photo, so each is read at several and the readings
 * vote.
 */
const INK_THRESHOLDS = [80, 100, 120, 140, 160, 180];

/**
 * The ways a strip is prepared before reading. The black-ink layer at each
 * threshold suits dark print; the plain and the thresholded greys catch print
 * that is too light to survive the layer.
 */
function preparations(canvas) {
  return [
    ...INK_THRESHOLDS.map((threshold) => keepBlack(canvas, threshold)),
    grayscale(canvas),
    binarize(canvas),
  ];
}

/** The languages the installed tesseract can read, looked up once. */
let installedLanguages = null;
export function tesseractLanguages() {
  if (installedLanguages === null) {
    try {
      const listing = execFileSync('tesseract', ['--list-langs'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      installedLanguages = listing
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => /^[a-z_]+$/.test(line));
    } catch {
      installedLanguages = [];
    }
  }
  return installedLanguages;
}

/** A printed dd.mm.yyyy as ISO, or null when it is not a calendar date. */
function printedDate(text) {
  const match = text.replace(/\s/g, '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) {
    return null;
  }
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(+year, +month - 1, +day));
  const real =
    date.getUTCFullYear() === +year &&
    date.getUTCMonth() === +month - 1 &&
    date.getUTCDate() === +day &&
    +year >= 1900 &&
    +year <= 2100;
  return real ? `${year}-${month}-${day}` : null;
}

/** A rectangle of a canvas, in pixels, as its own canvas. */
function cutPixels(canvas, { left, top, width, height }) {
  const x = Math.max(0, Math.round(left));
  const y = Math.max(0, Math.round(top));
  return regionCanvas(canvas, {
    x: x / canvas.width,
    y: y / canvas.height,
    w: Math.min(canvas.width - x, Math.round(width)) / canvas.width,
    h: Math.min(canvas.height - y, Math.round(height)) / canvas.height,
  });
}

/**
 * Every dd.mm.yyyy printed on the page, with where it sits.
 *
 * The page is read once per ink threshold and a date seen at the same place
 * more than once collects the votes, so a digit misread at one threshold does
 * not outvote the clean readings.
 */
function findPrintedDates(page) {
  const found = [];
  for (const prepared of preparations(page)) {
    const words = ocrData(prepared, { psm: 11, whitelist: '0123456789.' });
    for (const word of words) {
      const iso = printedDate(word.text);
      if (!iso) {
        continue;
      }
      const same = found.find(
        (date) =>
          date.iso === iso &&
          Math.abs(date.x - word.x) < word.h * 2 &&
          Math.abs(date.y - word.y) < word.h
      );
      if (same) {
        same.votes += 1;
      } else {
        found.push({ ...word, iso, votes: 1 });
      }
    }
  }
  return found;
}

/**
 * Reads the row to the left of a date box for another date.
 *
 * On a passport that prints the issue and expiry dates side by side, the
 * expiry date, which the machine-readable zone gives, marks the row.
 */
function datesLeftOf(page, anchor) {
  const strip = upscale(
    cutPixels(page, {
      left: 0,
      top: anchor.y - anchor.h * 0.5,
      width: anchor.x - anchor.h * 0.5,
      height: anchor.h * 2,
    }),
    2
  );
  const found = [];
  for (const prepared of preparations(strip)) {
    const text = ocrCanvas(prepared, { psm: 7, whitelist: '0123456789.' });
    debug('row left of', anchor.iso, text);
    const iso = loneDate(text);
    if (!iso) {
      continue;
    }
    const same = found.find((date) => date.iso === iso);
    if (same) {
      same.votes += 1;
    } else {
      // Passports that print the two dates side by side put the issue date
      // one date's width to the left; the box is that, for what anchors on it.
      found.push({
        iso,
        votes: 1,
        x: Math.max(0, anchor.x - anchor.w * 1.4),
        y: anchor.y,
        w: anchor.w,
        h: anchor.h,
      });
    }
  }
  return found;
}

/**
 * The one date in a strip that holds nothing else, read leniently.
 *
 * Light print gains a stray digit at the edge of a glyph, so a reading of
 * nine digits is tried with each one dropped; it counts only when every drop
 * that gives a calendar date gives the same one.
 */
function loneDate(text) {
  const digits = text.replace(/\D/g, '');
  if (digits.length === 8) {
    return printedDate(
      `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`
    );
  }
  if (digits.length !== 9) {
    return null;
  }
  const readings = new Set();
  for (let drop = 0; drop < digits.length; drop++) {
    const kept = digits.slice(0, drop) + digits.slice(drop + 1);
    const iso = printedDate(
      `${kept.slice(0, 2)}.${kept.slice(2, 4)}.${kept.slice(4)}`
    );
    if (iso) {
      readings.add(iso);
    }
  }
  return readings.size === 1 ? [...readings][0] : null;
}

/** Prints what the reader saw, when EVISA_OCR_DEBUG is set. */
function debug(...parts) {
  if (process.env.EVISA_OCR_DEBUG) {
    console.error(
      '[passport page]',
      ...parts.map((part) => JSON.stringify(part))
    );
  }
}

/**
 * Looks for one known date inside a rectangle of the page and returns where
 * it is, in page coordinates.
 *
 * The birth date shares its row with the place of birth, and read across the
 * whole page the two run together into one unreadable word. Read within the
 * rows above the issue date, where a passport prints it, it separates.
 */
function findDateWithin(page, iso, rectangle) {
  const cut = cutPixels(page, rectangle);
  if (cut.width < 8 || cut.height < 8) {
    return null;
  }
  const strip = upscale(cut, 2);
  for (const prepared of preparations(strip)) {
    const words = ocrData(prepared, { psm: 11, whitelist: '0123456789.' });
    debug('date within', iso, words.map((word) => word.text).join(' '));
    // The date often comes back in pieces, "07" "12." "1985", so each row of
    // pieces is read as one, and the box is the span of the row.
    for (const row of rowsFromWords(words)) {
      // The row holds the date when its digits do, allowing for a leading
      // zero that light print drops.
      const digits = row.map((word) => word.text.replace(/\D/g, '')).join('');
      const wanted = `${iso.slice(8)}${iso.slice(5, 7)}${iso.slice(0, 4)}`;
      if (!digits.includes(wanted) && !digits.includes(wanted.slice(1))) {
        continue;
      }
      const left = Math.min(...row.map((word) => word.x));
      const right = Math.max(...row.map((word) => word.x + word.w));
      const top = Math.min(...row.map((word) => word.y));
      const bottom = Math.max(...row.map((word) => word.y + word.h));
      return {
        iso,
        x: Math.max(0, rectangle.left) + left / 2,
        y: Math.max(0, rectangle.top) + top / 2,
        w: (right - left) / 2,
        h: (bottom - top) / 2,
        votes: 1,
      };
    }
  }
  return null;
}

/**
 * Picks the issue date among the dates on the page: the one that is neither
 * the birth date nor the expiry, falls between them, and has already come.
 * Two candidates with equal support settle nothing, and nothing is returned.
 */
function pickIssueDate(dates, known) {
  const today = new Date().toISOString().slice(0, 10);
  // A passport runs ten years at most, so an issue date further than that
  // before the expiry is something else misread: a birth date with one digit
  // off, most often.
  const earliest = known.passportExpiryDate
    ? `${Number(known.passportExpiryDate.slice(0, 4)) - 10}-01-01`
    : '';
  // A passport issued on the day its expiry falls on, five or ten years
  // earlier, is the ordinary case, and a reading that lands on it is
  // credited as if two more readings had agreed with it.
  const anniversary = (iso) =>
    Boolean(known.passportExpiryDate) &&
    iso.slice(4) === known.passportExpiryDate.slice(4) &&
    [5, 10].includes(
      Number(known.passportExpiryDate.slice(0, 4)) - Number(iso.slice(0, 4))
    );
  const candidates = dates
    .filter(
      (date) =>
        date.iso !== known.dateOfBirth &&
        date.iso !== known.passportExpiryDate &&
        (!known.dateOfBirth || date.iso > known.dateOfBirth) &&
        (!known.passportExpiryDate || date.iso < known.passportExpiryDate) &&
        date.iso >= earliest &&
        date.iso <= today
    )
    .map((date) => ({
      ...date,
      votes: date.votes + (anniversary(date.iso) ? 2 : 0),
    }))
    .sort((a, b) => b.votes - a.votes);
  if (!candidates.length) {
    return null;
  }
  if (candidates.length > 1 && candidates[0].votes === candidates[1].votes) {
    return null;
  }
  return candidates[0];
}

/**
 * Reads a strip of printed text, one reading per preparation, in the
 * languages installed, and returns the value the readings agree on after
 * `clean` reduces each to what it can be.
 *
 * Print over a security pattern rarely reads the same way twice, so the vote
 * is taken after cleaning: two readings that differ only in a stray mark are
 * one value. A value with no support beyond a single reading is still offered
 * when nothing contradicts it; a tie between two values settles nothing.
 */
function readStrip(page, rectangle, { lang, whitelist, clean }) {
  const cut = cutPixels(page, rectangle);
  if (cut.width < 8 || cut.height < 8) {
    return null;
  }
  const strip = upscale(cut, 2);
  const votes = new Map();
  for (const prepared of preparations(strip)) {
    // Read as a line and as a single word: the two segment the print
    // differently, and a digit lost by one is often kept by the other.
    for (const psm of [7, 8]) {
      const reading = ocrCanvas(prepared, { psm, lang, whitelist });
      const value = clean(reading);
      debug('strip', reading, value);
      if (value) {
        votes.set(value, (votes.get(value) ?? 0) + 1);
      }
    }
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) {
    return null;
  }
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
    return null;
  }
  return ranked[0][0];
}

/** Latin letters an OCR engine reads for the Cyrillic ones shaped like them. */
const LOOKALIKES = {
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
  Y: 'У',
};

/**
 * Rewrites a word the engine read in Latin lookalikes back to Cyrillic, when
 * the word is Cyrillic already in part or made of lookalikes throughout.
 * "MOCKBA" is МОСКВА misread; "USSR" has letters no Cyrillic word could give.
 */
function asCyrillic(word) {
  const letters = word.match(/\p{L}/gu) ?? [];
  const cyrillic = letters.some((letter) => /[Ѐ-ӿ]/.test(letter));
  const allLookalikes = letters.every(
    (letter) => /[Ѐ-ӿ]/.test(letter) || LOOKALIKES[letter]
  );
  if (!cyrillic && !allLookalikes) {
    return word;
  }
  return word.replace(/[ABCEHKMOPTXY]/g, (letter) => LOOKALIKES[letter]);
}

/** Countries as passports print them in Latin after the place of birth. */
const LATIN_PLACES = [
  'RUSSIA',
  'USSR',
  'INDIA',
  'UKRAINE',
  'BELARUS',
  'KAZAKHSTAN',
  'UZBEKISTAN',
  'KYRGYZSTAN',
  'TAJIKISTAN',
  'ARMENIA',
  'GEORGIA',
  'MOLDOVA',
  'GERMANY',
  'VIETNAM',
  'THAILAND',
  'TURKEY',
  'CHINA',
];

/** The words of the labels printed over the values, which name no place. */
const LABEL_WORDS = new Set([
  'МЕСТО',
  'РОЖДЕНИЯ',
  'ДАТА',
  'ПОЛ',
  'ЛИЧНЫЙ',
  'КОД',
  'PLACE',
  'BIRTH',
  'DATE',
  'SEX',
  'PERSONAL',
]);

/** Snaps a Latin word to the country it is one misread away from. */
function knownPlace(word) {
  if (word.length < 4) {
    return word;
  }
  return LATIN_PLACES.find((place) => editDistance(word, place) <= 1) ?? word;
}

/**
 * The words in a reading of the place of birth that could be part of it: the
 * native name in Cyrillic, three letters or more, and a Latin country the
 * list knows. Everything else is the pattern read as letters.
 */
function placeWords(reading) {
  const words = reading
    .toUpperCase()
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length >= 3 && !LABEL_WORDS.has(word))
    .map(asCyrillic);
  return {
    native: words.filter((word) => /^[Ѐ-ӿ]+$/.test(word)),
    latin: words
      .filter((word) => /^[A-Z]+$/.test(word))
      .map(knownPlace)
      .filter((word) => LATIN_PLACES.includes(word)),
  };
}

/**
 * The word the readings agree on, or the only one offered. Several words
 * seen once each settle nothing.
 */
function agreedWord(words, trusted = () => false) {
  const counts = new Map();
  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  // A place the dictionary knows outranks any word it does not, however
  // often the other was read: the pattern reads as letters more often than
  // as a known name.
  const known = [...counts.entries()].filter(([word]) => trusted(word));
  const ranked = (known.length ? known : [...counts.entries()]).sort(
    (a, b) => b[1] - a[1]
  );
  if (!ranked.length || (ranked.length > 1 && ranked[0][1] === ranked[1][1])) {
    return null;
  }
  // A word with a single reading behind it is usually the pattern read as
  // letters; it counts only when it is a place the dictionary knows.
  const [word, count] = ranked[0];
  return count >= 2 || trusted(word) ? word : null;
}

/**
 * Reads the place of birth as the passport prints it: the native name, a
 * slash, the country in Latin letters, either half on its own if that is
 * all that reads. Each half is voted separately, since the pattern breaks
 * up one reading here and another there.
 */
function readPlace(page, rectangle, lang) {
  const row = cutPixels(page, rectangle);
  if (row.width < 8 || row.height < 8) {
    return null;
  }
  // The anchor can land a line high, on the label over the value, so a
  // block taking in the next two lines is read as well, as sparse text; the
  // label's own words never name a place and drop out of the vote.
  const block = cutPixels(page, { ...rectangle, height: rectangle.height * 2 });
  const readings = [
    [upscale(row, 2), 7],
    [upscale(block, 2), 11],
  ];
  const native = [];
  const latin = [];
  for (const [strip, psm] of readings) {
    for (const prepared of preparations(strip)) {
      const reading = ocrCanvas(prepared, { psm, lang });
      const words = placeWords(reading);
      debug('place', psm, reading, words);
      native.push(...words.native);
      latin.push(...words.latin);
    }
  }
  const halves = [
    agreedWord(native, isKnownPlace),
    agreedWord(latin, (word) => LATIN_PLACES.includes(word)),
  ].filter(Boolean);
  return halves.length ? halves.join('/') : null;
}

/** Bodies that issue Russian passports, as printed before their code. */
const AUTHORITIES = [
  'МВД',
  'ФМС',
  'УФМС',
  'ОУФМС',
  'ГУВД',
  'УВД',
  'ОВД',
  'МИД',
];

/**
 * The issuing body in a reading of the authority line: one of the
 * abbreviations Russian passports print, allowing one misread letter in the
 * longer ones. Anything else is noise and yields nothing.
 */
function cleanAuthorityBody(reading) {
  const tokens = reading
    .toUpperCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(asCyrillic);
  for (const token of tokens) {
    const body = AUTHORITIES.find(
      (name) => token.length >= 3 && editDistance(token, name) <= 1
    );
    if (body) {
      return body;
    }
  }
  return null;
}

/**
 * A consular authority in a reading of the authority line: a passport
 * issued abroad names "Г/К РОССИИ, <city>", the consulate general, or an
 * embassy, with no code after it. Anything else yields nothing.
 */
export function cleanConsularAuthority(reading) {
  const tokens = String(reading ?? '')
    .toUpperCase()
    .split(/[^\p{L}/]+/u)
    .filter(Boolean)
    .map(asCyrillic);
  const at = tokens.findIndex(
    (token) => token.length >= 6 && editDistance(token.slice(-6), 'РОССИИ') <= 1
  );
  if (at < 0) {
    return null;
  }
  const before = tokens[at].slice(0, -6) || tokens[at - 1] || '';
  const body =
    editDistance(before, 'ПОСОЛЬСТВО') <= 2
      ? 'ПОСОЛЬСТВО РОССИИ'
      : 'Г/К РОССИИ';
  const city = tokens
    .slice(at + 1)
    .filter((token) => token !== 'В' && /^[Ѐ-ӿ]{3,}$/.test(token))
    .slice(0, 2)
    .join(' ');
  return city ? `${body}, ${city}` : null;
}

/**
 * The code in a reading of the authority line, read with digits alone
 * allowed so the letters beside it cannot bleed into it. A zero often reads
 * as the letter O over the pattern, and is taken as one.
 */
function cleanAuthorityCode(reading) {
  const code = reading.replace(/[OО]/g, '0').replace(/\D/g, '');
  return code.length >= 4 && code.length <= 6 ? code : null;
}

/**
 * Reads the fields printed beside the machine-readable zone's own.
 *
 * The zone carries no issue date, place of birth or issuing authority, and
 * the form asks for all three. On the printed side they sit in fixed places
 * relative to the dates the zone does give: the issue date shares a row with
 * the expiry, the place of birth follows the date of birth, and the authority
 * is printed under the issue date. Those dates are found on the page and used
 * as anchors, which holds up where reading the labels does not: the labels
 * are small grey print over the security pattern, the values are black.
 *
 * `known` is what the zone gave, as ISO dates; it decides which printed date
 * is which. Anything not read cleanly is left out; nothing is guessed.
 */
export async function readPassportPage(imagePath, known = {}) {
  const image = await renderImage(imagePath);
  const page = upscale(regionCanvas(image, { x: 0, y: 0, w: 1, h: 0.88 }), 2);
  const lang = tesseractLanguages().includes('rus') ? 'rus+eng' : 'eng';

  const dates = findPrintedDates(page);
  const expiry = dates.find((date) => date.iso === known.passportExpiryDate);
  if (expiry) {
    addDates(dates, datesLeftOf(page, expiry));
  }
  const issue = pickIssueDate(dates, known);
  const birth = findBirthDate(page, dates, issue, known);

  const data = {};
  if (issue) {
    data.passportIssueDate = issue.iso;
  }
  const place = birth && readPlaceBeside(page, birth, lang);
  if (place) {
    data.placeOfBirth = place;
  }
  const printedName =
    birth?.w &&
    known.givenName &&
    readPrintedGivenName(page, birth, known.givenName);
  if (printedName) {
    data.givenNameAsPrinted = printedName;
  }
  const authority = issue?.w && readAuthorityUnder(page, issue, expiry, lang);
  if (authority) {
    data.passportIssuingAuthority = authority;
  }
  return { data, dates: dates.map(({ iso, votes }) => ({ iso, votes })) };
}

/** Adds readings of dates to those found, pooling the votes for a date seen twice. */
function addDates(dates, more) {
  for (const date of more) {
    const same = dates.find((seen) => seen.iso === date.iso);
    if (same) {
      same.votes += date.votes;
    } else {
      dates.push(date);
    }
  }
}

/**
 * Where the birth date is printed: found among the page's dates, failing
 * that in the rows above the issue date, failing that, on a Russian
 * passport, five and a half lines above the issue date in its column.
 */
function findBirthDate(page, dates, issue, known) {
  const found = dates.find((date) => date.iso === known.dateOfBirth && date.w);
  if (found || !issue?.w) {
    return found ?? null;
  }
  if (known.dateOfBirth) {
    const above = findDateWithin(page, known.dateOfBirth, {
      left: issue.x - issue.h,
      top: issue.y - issue.h * 8,
      width: issue.w + issue.h * 2,
      height: issue.h * 7,
    });
    if (above) {
      return above;
    }
  }
  if (known.nationality === 'Russia') {
    return { ...issue, y: issue.y - issue.h * 5.5 };
  }
  return null;
}

/** The place of birth, printed to the right of the birth date. */
function readPlaceBeside(page, birth, lang) {
  return readPlace(
    page,
    {
      left: birth.x + birth.w + birth.h * 0.3,
      top: birth.y - birth.h * 0.5,
      width: page.width,
      height: birth.h * 2,
    },
    lang
  );
}

/**
 * The issuing authority, printed under the issue date as a body and a code.
 * The two are read separately: the code with digits alone allowed, so the
 * letters beside it cannot bleed into it.
 */
function readAuthorityUnder(page, issue, expiry, lang) {
  // The value stands one line under the date on some passports and two on
  // others, under its own label, and how tall the date's box came out
  // varies with the photo; so a few bands under the date are read in turn.
  for (const offset of [1.3, 2.9, 4.5]) {
    const line = {
      left: issue.x - issue.h,
      top: issue.y + issue.h * offset,
      width: (expiry ? expiry.x - issue.x : issue.w * 2) + issue.h,
      height: issue.h * 2.4,
    };
    const body = readStrip(page, line, { lang, clean: cleanAuthorityBody });
    const code = readStrip(page, line, {
      whitelist: '0123456789O',
      clean: cleanAuthorityCode,
    });
    if (body && code) {
      return `${body} ${code}`;
    }
    // No body and code: a consulate abroad, named without one and at
    // greater length, so the strip runs on into the expiry column; the
    // reading keeps Cyrillic words only, and the expiry's digits pass it by.
    const consular = readStrip(
      page,
      { ...line, width: line.width + issue.h * 4 },
      { lang, clean: cleanConsularAuthority }
    );
    if (consular) {
      return consular;
    }
  }
  return null;
}

/**
 * The given name as the passport prints it in Latin letters, under the
 * native one, when it matches the zone's reading: the zone writes a hyphen
 * as a filler, so "[REDACTED]" comes out of it as two names, and
 * only the print has the hyphen.
 *
 * Read as a block of lines, since the print sits between the native name
 * and the nationality; a line that is the zone's name with hyphens for some
 * of its spaces, or one letter off, is the print. Null when none is.
 */
function readPrintedGivenName(page, birth, zoneName) {
  const cut = cutPixels(page, {
    left: birth.x - birth.h,
    top: birth.y - birth.h * 7,
    width: birth.h * 24,
    height: birth.h * 4,
  });
  if (cut.width < 8 || cut.height < 8) {
    return null;
  }
  const strip = upscale(cut, 2);
  const votes = new Map();
  for (const prepared of preparations(strip)) {
    const reading = ocrCanvas(prepared, {
      psm: 6,
      lang: 'eng',
      whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ- ',
    });
    for (const line of reading.split('\n')) {
      const candidate = line.trim().replace(/\s+/g, ' ');
      const asZone = candidate.replace(/-/g, ' ');
      if (candidate.includes('-') && editDistance(asZone, zoneName) <= 1) {
        votes.set(candidate, (votes.get(candidate) ?? 0) + 1);
      }
    }
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || (ranked.length > 1 && ranked[0][1] === ranked[1][1])) {
    return null;
  }
  return ranked[0][0];
}

/**
 * Finds the passport data page inside a wider photo and crops it out.
 *
 * A photo of a whole passport, or a page on a desk, carries background the form
 * has no use for. The page is found as the bright rectangle of paper against a
 * darker surround, which holds up where reading the print on it does not: a
 * dense page of text defeats that, a sheet of paper on a desk does not.
 *
 * The crop is lossless where it can be. Nothing is resized or re-encoded beyond
 * the single JPEG write, so quality is unchanged except for that one pass, and
 * when no MRZ is found the original is copied through untouched.
 */
export async function cropPassportPage(inputPath, outputPath) {
  const sharp = (await import('sharp')).default;
  const meta = await sharp(inputPath, { failOn: 'none' }).metadata();

  const band = await findMrzBand(inputPath, meta);
  // Cropping wrongly costs more than not cropping: it can cut away the very
  // fields the form needs. The page is only cut out when the band was found and
  // sits clearly inside a larger photo, which is the case a crop is meant for.
  const looksLikeWholePage =
    !band ||
    (band.width > meta.width * 0.92 && band.height > meta.height * 0.92);
  if (looksLikeWholePage) {
    fs.copyFileSync(inputPath, outputPath);
    return { cropped: false, width: meta.width, height: meta.height };
  }

  // A TD3 page is about 125x88mm and its MRZ sits along the bottom, so the page
  // is roughly the MRZ width and about 1.4 times as tall as it is wide.
  const pageWidth = Math.min(meta.width, Math.round(band.width * 1.06));
  const pageHeight = Math.min(meta.height, Math.round(pageWidth * 0.72));
  const left = Math.max(
    0,
    Math.round(band.left - (pageWidth - band.width) / 2)
  );
  // The bottom edge is measured from the zone itself, with a margin below it
  // scaled to the zone's own height. Deriving it from an estimated page height
  // can land above the zone and cut it off.
  const bottom = Math.min(
    meta.height,
    band.top + band.height + Math.round(band.height * 0.8)
  );
  // Prefer the fold when the photo shows one: it is where the page actually
  // ends, while the proportional height is only an estimate.
  const fold = await findFoldAbove(inputPath, band.top);
  const estimated = Math.max(0, bottom - pageHeight);
  const top = fold !== null && fold < bottom ? fold : estimated;
  // The top comes from the fold and the bottom from the zone, so the height
  // is whatever lies between them; a fixed height measured from a high fold
  // would end above the zone.
  const width = Math.min(pageWidth, meta.width - left);
  const height = bottom - top;

  await sharp(inputPath, { failOn: 'none' })
    .extract({ left, top, width, height })
    .jpeg({ quality: 95 })
    .toFile(outputPath);

  return { cropped: true, left, top, width, height };
}

/** The least a crease has to darken a column to count, in grey levels. */
const CREASE_DEPTH = 12;

/** The share of columns, in the emptiest third of the width, a seam must cross. */
const SEAM_SHARE = 0.6;

/**
 * Finds the fold between two pages of an open passport.
 *
 * A spread photographed flat shows the seam as a shadowed crease: a thin band
 * darker than the paper just above and just below it, running the whole width
 * of the page. A row of print, a signature rule or the edge of the photo can
 * look the same along one column, so every column is searched on its own for
 * such dips and each row counts the columns that dip there. The seam collects a
 * vote from nearly every column; print gets votes only where its letters are.
 *
 * The thirds of the width are counted separately and the emptiest one decides,
 * because print sits in the middle of a page and a seam does not: a heading or
 * a signature never reaches both margins, however dark it is.
 *
 * The cut goes on the lower edge of the crease, where the paper brightens into
 * the data page's own margin, so no shadow and none of the facing page remain.
 * A flat scan of a single page has no full-width dip and gets no cut. The rows
 * near the top and the machine-readable zone are left out of the search.
 */
export async function findFoldAbove(inputPath, mrzTop) {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(inputPath, { failOn: 'none' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  const bounds = {
    top: Math.round(height * 0.15),
    floor: Math.round(mrzTop - height * 0.15),
    // The crease is a fixed fraction of a page, so the distances scale with
    // the image: paper is sampled this far above and below a candidate row,
    // and this many rows either side are averaged to quiet the guilloche.
    reach: Math.max(4, Math.round(height * 0.015)),
    blur: Math.max(1, Math.round(height * 0.002)),
  };
  if (bounds.floor - bounds.top < bounds.reach * 4) {
    return null;
  }

  const thirds = countCreaseVotes(data, width, height, bounds);
  const share = (y) =>
    Math.min(...thirds.map((third) => third[y])) / (width / 3);
  let seam = bounds.top;
  for (let y = bounds.top; y < bounds.floor; y++) {
    if (share(y) > share(seam)) {
      seam = y;
    }
  }
  if (share(seam) < SEAM_SHARE) {
    return null;
  }

  // The darkest row is inside the crease. Its lower edge is the steepest
  // brightening below it, which is where the page's own paper begins.
  const rowMean = (y) => {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      sum += data[y * width + x];
    }
    return sum / width;
  };
  let edge = seam;
  let steepest = -Infinity;
  const last = Math.min(height - 2, seam + bounds.reach * 2);
  for (let y = seam; y <= last; y++) {
    const step = rowMean(y + 1) - rowMean(y);
    if (step > steepest) {
      steepest = step;
      edge = y + 1;
    }
  }
  return edge;
}

/**
 * Counts, for every row, the columns that dip dark there with paper on both
 * sides, kept in three tallies for the left, middle and right of the width.
 *
 * A dip is a local peak of how much darker a row is than the paper `reach` rows
 * above and below it. The rows around the peak are counted with it, since the
 * crease wanders by a row or two across the printed pattern.
 */
function countCreaseVotes(data, width, height, { top, floor, reach, blur }) {
  const thirds = [0, 1, 2].map(() => new Float64Array(height));
  const profile = new Float64Array(height);
  const dip = new Float64Array(height);
  const marked = new Uint8Array(height);

  for (let x = 0; x < width; x++) {
    for (let y = blur; y < height - blur; y++) {
      let sum = 0;
      for (let k = -blur; k <= blur; k++) {
        sum += data[(y + k) * width + x];
      }
      profile[y] = sum / (blur * 2 + 1);
    }
    for (let y = top; y < floor; y++) {
      dip[y] = Math.min(profile[y - reach], profile[y + reach]) - profile[y];
    }
    marked.fill(0);
    for (let y = top + 1; y < floor - 1; y++) {
      const isPeak =
        dip[y] >= CREASE_DEPTH && dip[y] >= dip[y - 1] && dip[y] > dip[y + 1];
      if (isPeak) {
        marked.fill(1, y - blur, y + blur + 1);
      }
    }
    const third = thirds[Math.min(2, Math.floor((x * 3) / width))];
    for (let y = top; y < floor; y++) {
      third[y] += marked[y];
    }
  }
  return thirds;
}

/**
 * Locates the machine-readable zone by the rows that carry it.
 *
 * The zone is two lines of evenly spaced glyphs running most of the page width,
 * so those rows cross between ink and paper far more often than any other. That
 * holds whether the page fills the frame, sits on a desk, or is one half of an
 * open spread, which page-edge detection does not.
 *
 * MRZ print is grey on white, so the ink threshold is deliberately generous; a
 * darker one misses the band completely.
 */
/**
 * For each row of a greyscale image: how often it crosses between ink and
 * paper, and where its ink begins and ends.
 */
function inkRows(data, width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    let crossings = 0;
    let first = -1;
    let last = -1;
    let wasInk = false;
    for (let x = 0; x < width; x++) {
      const ink = data[y * width + x] < 170;
      if (ink !== wasInk) {
        crossings += 1;
        wasInk = ink;
      }
      if (ink) {
        if (first === -1) {
          first = x;
        }
        last = x;
      }
    }
    rows.push({ crossings, first, last });
  }
  return rows;
}

async function findMrzBand(inputPath, meta) {
  if (!meta?.width || !meta?.height) {
    return null;
  }
  const sharp = (await import('sharp')).default;
  const width = 500;
  const height = Math.max(1, Math.round((meta.height / meta.width) * width));

  const { data } = await sharp(inputPath, { failOn: 'none' })
    .resize(width, height, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rows = inkRows(data, width, height);

  // The zone runs along the bottom of a data page. Searching only the lower
  // part keeps a fold from being mistaken for it: a crease crosses between
  // light and dark more often than the printed glyphs do, so on a spread it
  // would otherwise win.
  const lowest = Math.round(height * 0.6);
  const lower = rows.slice(lowest);
  const busiest = Math.max(...lower.map((row) => row.crossings));
  if (busiest < 30) {
    return null;
  }

  // Group the busy rows that sit close together; the lowest such group is the
  // machine-readable zone, since nothing on a passport sits below it.
  const marked = rows
    .map((row, y) => ({ ...row, y }))
    .filter((row) => row.y >= lowest && row.crossings >= busiest * 0.75);
  if (marked.length === 0) {
    return null;
  }

  const gap = Math.max(4, Math.round(height * 0.04));
  const groups = [[marked[0]]];
  for (const row of marked.slice(1)) {
    const current = groups[groups.length - 1];
    if (row.y - current[current.length - 1].y <= gap) {
      current.push(row);
    } else {
      groups.push([row]);
    }
  }

  const band = groups[groups.length - 1];
  // The second line of the zone is digits and a name's worth of fillers, and
  // crosses between ink and paper about half as often as a first line that is
  // mostly fillers. It has to be in the band all the same, or the page is cut
  // between the two lines and the zone cannot be read. So the band is grown
  // downwards over any nearby row that is busy at all.
  let last = band[band.length - 1].y;
  for (let y = last + 1; y < height && y - last <= gap; y++) {
    if (rows[y].crossings >= busiest * 0.35) {
      band.push({ ...rows[y], y });
      last = y;
    }
  }
  const scaleX = meta.width / width;
  const scaleY = meta.height / height;
  return {
    left: Math.round(Math.min(...band.map((row) => row.first)) * scaleX),
    width: Math.round(
      (Math.max(...band.map((row) => row.last)) -
        Math.min(...band.map((row) => row.first)) +
        1) *
        scaleX
    ),
    top: Math.round(band[0].y * scaleY),
    height: Math.round((band[band.length - 1].y - band[0].y + 1) * scaleY),
  };
}

/**
 * Renders any supported input (including a PDF page) to a JPEG that satisfies
 * the upload rules: JPEG format, under 2 MB.
 */
export async function prepareUploadImage(inputPath, outputPath) {
  const sharp = (await import('sharp')).default;

  let source = inputPath;
  let cleanup = null;
  if (path.extname(inputPath).toLowerCase() === '.pdf') {
    const canvas = await renderImage(inputPath);
    source = `${outputPath}.source.png`;
    fs.writeFileSync(source, canvas.toBuffer('image/png'));
    cleanup = source;
  }

  // A JPEG that already fits the limit is uploaded byte for byte. Re-encoding
  // it would only lose detail, and any reframing would cut into the
  // head-and-shoulders composition the reviewer checks.
  const isJpeg = /\.jpe?g$/i.test(source);
  if (isJpeg && fs.statSync(source).size <= PHOTO_RULES.maxBytes) {
    fs.copyFileSync(source, outputPath);
    if (cleanup) {
      fs.rmSync(cleanup, { force: true });
    }
    return {
      path: outputPath,
      bytes: fs.statSync(outputPath).size,
      unchanged: true,
    };
  }

  // Otherwise shrink it just enough to clear the ceiling, preserving the
  // aspect ratio and never enlarging. The camera's metadata stays with it:
  // the site judges whether a portrait is an original or a copy, and a
  // photo stripped of everything a camera writes looks like a copy.
  const pipeline = sharp(source, { failOn: 'none' })
    .rotate()
    .withMetadata()
    .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true });

  let quality = 92;
  let buffer = await pipeline.jpeg({ quality }).toBuffer();
  while (buffer.length > PHOTO_RULES.maxBytes && quality > 40) {
    quality -= 10;
    buffer = await pipeline.jpeg({ quality }).toBuffer();
  }
  fs.writeFileSync(outputPath, buffer);
  if (cleanup) {
    fs.rmSync(cleanup, { force: true });
  }

  return {
    path: outputPath,
    bytes: buffer.length,
    quality,
    unchanged: false,
  };
}
