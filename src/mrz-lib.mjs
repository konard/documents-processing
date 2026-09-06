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
  // Passports run at most ~10 years, so an expiry year sits in a narrow window
  // around today. Reading it with the birth-year pivot of 30 would turn a
  // passport expiring in '32 into 1932; sliding the window forward keeps both
  // recently expired and long-dated passports in the right century.
  if (kind === 'future') {
    return n < (new Date().getUTCFullYear() % 100) - 10 ? 2100 + n : 2000 + n;
  }
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

  // Coerce the numeric fields to digits (fixing O->0, I->1, B->8, ...).
  const passport = toDigits(g[1]);
  const cP = toDigits(g[2]);
  const nat = g[3];
  const dob = toDigits(g[4]);
  const cD = toDigits(g[5]);
  const sex = g[6] === '<' ? '' : g[6];
  const exp = toDigits(g[7]);
  const cE = toDigits(g[8]);

  return {
    passportNumber: passport.replace(/</g, ''),
    passportCheckOk: mrzCheck(passport) === +cP,
    nationality: nat.replace(/</g, ''),
    dob: `${String(yy(dob.slice(0, 2))).padStart(4, '0')}-${dob.slice(2, 4)}-${dob.slice(4, 6)}`,
    dobCheckOk: mrzCheck(dob) === +cD,
    sex,
    expiry: `${yy(exp.slice(0, 2), 'future')}-${exp.slice(2, 4)}-${exp.slice(4, 6)}`,
    expiryCheckOk: mrzCheck(exp) === +cE,
  };
}

export function parseMrzLine1(raw) {
  const s = raw.replace(/[^A-Z<]/g, '');
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
