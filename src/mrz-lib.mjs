// mrz-lib.mjs
//
// Parsing for the machine-readable zone printed at the bottom of a passport
// data page (ICAO 9303 TD3).
//
// This module is deliberately free of dependencies: it is pure string handling,
// so it can be imported and tested without pulling in the native image and PDF
// libraries that the rest of the OCR pipeline needs.

function mrzVal(ch) {
  if (ch === '<') {
    return 0;
  }
  if (ch >= '0' && ch <= '9') {
    return ch.charCodeAt(0) - 48;
  }
  return ch.charCodeAt(0) - 55;
}
function mrzCheck(str) {
  const w = [7, 3, 1];
  let s = 0;
  for (let i = 0; i < str.length; i++) {
    s += mrzVal(str[i]) * w[i % 3];
  }
  return s % 10;
}
// The MRZ stores a two-digit year, so the century has to be inferred.
// A birth year cannot be in the future, while an expiry year is always ahead of
// the issue date, so each needs its own pivot: without this a passport expiring
// in '32 would be read as 1932.
const yy = (y, kind = 'past') => {
  const n = +y;
  // An expiry year is always this century: no passport read today expired
  // before 2000, and none runs past 2099. Reading it with the birth-year
  // pivot of 30 would turn a passport expiring in '32 into 1932.
  if (kind === 'future') {
    return 2000 + n;
  }
  // Birth years: '00 to '30 are this century, the rest the last. Someone
  // born after 2030 will need this pivot moved.
  return n <= 30 ? 2000 + n : 1900 + n;
};

// Force a substring to digits, fixing the common OCR letter->digit confusions
// that occur in numeric MRZ fields (O->0, I/L->1, B->8, S->5, etc.).
const L2D = {
  O: '0',
  Q: '0',
  D: '0',
  I: '1',
  L: '1',
  Z: '2',
  B: '8',
  S: '5',
  G: '6',
  T: '7',
  A: '4',
  '<': '0',
};
const toDigits = (s) =>
  s
    .split('')
    .map((c) => (/\d/.test(c) ? c : (L2D[c] ?? c)))
    .join('');

/**
 * Digits a glyph is plausibly confused with, beyond the first choice in L2D.
 *
 * A tall narrow mark reads as `I` but is also how a `9` with a faint bowl comes
 * out; `S` and `5`, `B` and `8` blur the same way. Each entry lists the other
 * readings worth trying when a field fails its check digit.
 */
const AMBIGUOUS = {
  I: ['1', '9', '7', '4'],
  L: ['1', '4'],
  O: ['0', '9', '8'],
  Q: ['0', '9'],
  D: ['0', '8'],
  S: ['5', '8', '6'],
  B: ['8', '6', '3'],
  G: ['6', '8', '9'],
  Z: ['2', '7'],
  T: ['7', '1'],
  A: ['4'],
  1: ['1', '7', '4'],
  7: ['7', '1'],
  8: ['8', '6', '3', '5'],
  9: ['9', '4', '8'],
  0: ['0', '8', '6'],
  5: ['5', '6', '8'],
  6: ['6', '5', '8'],
  4: ['4', '1', '9'],
  3: ['3', '8'],
  2: ['2', '7'],
};

/** Every reading of `raw` with the character at `index` swapped for `digit`. */
function substitute(chars, index, digit) {
  const candidate = [...chars];
  candidate[index] = digit;
  return candidate.join('');
}

/** Candidate readings that differ from the original in exactly `count` places. */
function* candidates(chars, options, count) {
  if (count === 1) {
    for (let i = 0; i < chars.length; i++) {
      for (const digit of options[i]) {
        if (digit !== chars[i]) {
          yield substitute(chars, i, digit);
        }
      }
    }
    return;
  }
  for (let i = 0; i < chars.length; i++) {
    for (const digit of options[i]) {
      const swapped = substitute(chars, i, digit).split('');
      for (let j = i + 1; j < chars.length; j++) {
        for (const other of options[j]) {
          if (digit === chars[i] && other === chars[j]) {
            continue;
          }
          yield substitute(swapped, j, other);
        }
      }
    }
  }
}

/**
 * Repairs a numeric MRZ field whose check digit does not match.
 *
 * The check digit makes a misread detectable, and usually correctable: only one
 * substitution among the plausible confusions normally satisfies it. Positions
 * are tried one and then two at a time, and a repair is accepted only when
 * exactly one candidate validates. An ambiguous case is left alone and stays
 * reported as unverified.
 */
export function repairByCheckDigit(
  raw,
  expectedCheck,
  isPlausible = () => true
) {
  if (mrzCheck(raw) === expectedCheck) {
    return { value: raw, repaired: false };
  }

  const chars = raw.split('');
  const options = chars.map((c) => AMBIGUOUS[c] ?? [c]);

  for (const count of [1, 2]) {
    const matches = new Set();
    for (const text of candidates(chars, options, count)) {
      if (mrzCheck(text) === expectedCheck && isPlausible(text)) {
        matches.add(text);
      }
    }
    if (matches.size === 1) {
      return { value: [...matches][0], repaired: true };
    }
    if (matches.size > 1) {
      break;
    }
  }

  return { value: raw, repaired: false };
}

/** A YYMMDD field is only plausible if it names a real month and day. */
function isPlausibleDate(digits) {
  const month = +digits.slice(2, 4);
  const day = +digits.slice(4, 6);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * Reads a date field, repairing it against its check digit where possible.
 *
 * A repair has to produce a real calendar date as well as satisfy the check
 * digit: several wrong candidates can match the checksum, and one that yields
 * month 63 is obviously not the reading we want. When no candidate is
 * plausible the original stands and the field stays unverified.
 */
function readDateField(raw, check) {
  const fixed = repairByCheckDigit(raw, +check, (candidate) =>
    isPlausibleDate(toDigits(candidate))
  );
  const digits = toDigits(fixed.value);
  const ok = mrzCheck(fixed.value) === +check && isPlausibleDate(digits);
  return { digits, ok, repaired: fixed.repaired };
}

export function parseMrzLine2(raw) {
  const s = raw.replace(/[^A-Z0-9<]/g, '');
  // Match the TD3 line-2 shape allowing letters in numeric fields (OCR may have
  // misread digits as letters). The optional extra char after nationality
  // absorbs a stray inserted glyph seen on some scans.
  const shapes = [
    /^([A-Z0-9<]{9})([\dA-Z])([A-Z<]{3})([\dA-Z]{6})([\dA-Z])([MFX<])([\dA-Z]{6})([\dA-Z])/,
    /^([A-Z0-9<]{9})([\dA-Z])([A-Z<]{3})[\dA-Z]([\dA-Z]{6})([\dA-Z])([MFX<])([\dA-Z]{6})([\dA-Z])/,
  ];
  let g = null;
  for (const re of shapes) {
    g = s.match(re);
    if (g) {
      break;
    }
  }
  if (!g) {
    return null;
  }

  // Coerce the numeric fields to digits (fixing O->0, I->1, B->8, ...), then
  // let each field's check digit correct any remaining glyph confusion.
  const cP = toDigits(g[2]);
  const nat = g[3];
  const cD = toDigits(g[5]);
  const sex = g[6] === '<' ? '' : g[6];
  const cE = toDigits(g[8]);

  // Only dates are repaired. A date has a second, independent constraint - it
  // must name a real month and day - which makes a correction verifiable. A
  // passport number has nothing but its check digit, and many wrong candidates
  // satisfy that, so a "repaired" number would just be a plausible-looking
  // guess. Reporting it as unverified is the honest answer.
  const passport = toDigits(g[1]);
  // Repair works on the raw field, before letters are flattened to digits: an
  // `I` can be a misread 9 as easily as a 1, and collapsing it first throws
  // away the alternative that the check digit would have picked.
  const dob = readDateField(g[4], cD);
  const exp = readDateField(g[7], cE);

  return {
    passportNumber: passport.replace(/</g, ''),
    passportCheckOk: mrzCheck(passport) === +cP,
    nationality: nat.replace(/</g, ''),
    dob: `${String(yy(dob.digits.slice(0, 2))).padStart(4, '0')}-${dob.digits.slice(2, 4)}-${dob.digits.slice(4, 6)}`,
    dobCheckOk: dob.ok,
    sex,
    expiry: `${yy(exp.digits.slice(0, 2), 'future')}-${exp.digits.slice(2, 4)}-${exp.digits.slice(4, 6)}`,
    expiryCheckOk: exp.ok,
    // Which fields the check digit had to correct, so a caller can show them.
    repaired: [dob.repaired && 'dateOfBirth', exp.repaired && 'expiry'].filter(
      Boolean
    ),
  };
}

/**
 * Digits an OCR engine produces for a letter in a name.
 *
 * Line 1 of an MRZ holds only letters and filler, so a digit there is always a
 * misread. Mapping it back is safe, and dropping it instead would silently
 * shorten the name.
 */
const D2L = { 0: 'O', 1: 'I', 5: 'S', 8: 'B', 2: 'Z', 6: 'G', 4: 'A', 7: 'T' };

export function parseMrzLine1(raw) {
  const s = raw
    .toUpperCase()
    // A digit with no letter it is mistaken for is noise and is dropped: a
    // name is read between fillers, not by position, so the letters around
    // it still make the name.
    .replace(/[0-9]/g, (digit) => D2L[digit] ?? '')
    .replace(/[^A-Z<]/g, '');
  const m = s.match(/^P[A-Z<]?([A-Z]{3})([A-Z<]+)$/);
  if (!m) {
    return null;
  }
  const parts = m[2].replace(/<+$/, '').split(/<<+/);
  const clean = (t) =>
    (t || '')
      .replace(/</g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .join(' ')
      .trim();
  return { issuer: m[1], surname: clean(parts[0]), given: clean(parts[1]) };
}
