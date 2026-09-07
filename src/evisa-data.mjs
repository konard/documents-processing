// evisa-data.mjs
//
// Turns applicant data from any source (JSON, lino, OCR of a passport, an
// earlier Vietnam e-visa) into the exact shape the e-visa form expects, and
// reports what is missing or wrong before a browser is ever opened.

import {
  FIELDS,
  RADIO_GROUPS,
  KNOWN_KEYS,
  MAX_EVISA_DAYS,
  AIR_BORDER_GATES,
  PURPOSES,
  FIELD_DEFAULTS,
} from './evisa-schema.mjs';

/** Everyday wordings for the purpose of entry, mapped to the site's options. */
const PURPOSE_SYNONYMS = {
  tourism: 'Tourist',
  tourist: 'Tourist',
  holiday: 'Tourist',
  vacation: 'Tourist',
  travel: 'Tourist',
  sightseeing: 'Tourist',
  work: 'Working',
  working: 'Working',
  employment: 'Working',
  business: 'Business',
  'visiting relatives': 'Visiting relatives',
  family: 'Visiting relatives',
  'family visit': 'Visiting relatives',
};

/**
 * Resolves a border gate to the spelling the dropdown uses.
 *
 * People write "Noi Bai" or the instruction page's "Noi Bai Airport Border
 * Gate"; the form only accepts "Noi Bai Int Airport". A name is rewritten only
 * when it identifies exactly one gate; an ambiguous entry is left alone for
 * validation to flag.
 */
export function canonicalBorderGate(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return value;
  }
  const text = value.trim();
  const exact = AIR_BORDER_GATES.find(
    (gate) => gate.toLowerCase() === text.toLowerCase()
  );
  if (exact) {
    return exact;
  }
  // Compare on the distinctive part of the name, ignoring the boilerplate that
  // differs between the instruction page and the form.
  const core = text
    .toLowerCase()
    .replace(
      /\b(int|international)?\s*(airport|border gate|seaport|port)\b/g,
      ' '
    )
    .replace(/[(),]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!core) {
    return value;
  }
  const matches = AIR_BORDER_GATES.filter((gate) =>
    gate.toLowerCase().includes(core)
  );
  return matches.length === 1 ? matches[0] : value;
}

/** Resolves a purpose of entry to one of the form's five options. */
export function canonicalPurpose(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return value;
  }
  const text = value.trim();
  const exact = PURPOSES.find((p) => p.toLowerCase() === text.toLowerCase());
  return exact ?? PURPOSE_SYNONYMS[text.toLowerCase()] ?? value;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Formats a Date as the DD/MM/YYYY string every date input on the form wants.
 */
export function toFormDate(value) {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) {
    return null;
  }
  return `${pad2(date.getUTCDate())}/${pad2(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

/**
 * Parses the date shapes documents actually carry: ISO (from MRZ parsing),
 * DD/MM/YYYY and DD.MM.YYYY (printed on passports and visas), and the
 * DD MMM YYYY form used on many visa stickers.
 */
export function parseDate(input) {
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }
  if (typeof input !== 'string') {
    return null;
  }
  const text = input.trim();
  if (!text) {
    return null;
  }

  const months = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };

  let y;
  let m;
  let d;
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    [, y, m, d] = match.map(Number);
  }
  if (!match) {
    match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (match) {
      [, d, m, y] = match.map(Number);
    }
  }
  if (!match) {
    match = text.match(/^(\d{1,2})[\s-]*([A-Za-z]{3})[A-Za-z]*[\s-]*(\d{4})$/);
    if (match) {
      d = Number(match[1]);
      m = months[match[2].toLowerCase()];
      y = Number(match[3]);
    }
  }
  if (!match || !m) {
    return null;
  }

  const date = new Date(Date.UTC(y, m - 1, d));
  // Reject impossible calendar dates such as 31/02: the round-trip shifts them.
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

/** Whole days between two dates, inclusive of both endpoints. */
export function inclusiveDays(from, to) {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / 86400000) + 1;
}

/**
 * Uppercases and strips diacritics/punctuation from a name so it matches the
 * machine-readable zone, which is what the Immigration Department compares.
 */
export function normalizeName(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Normalizes a whole applicant record: dates become DD/MM/YYYY, names are
 * upper-cased, and the email confirmation is mirrored when it was left out.
 */
/** Formats each known field and drops the ones left empty. */
function normalizeFields(out) {
  for (const [key, field] of Object.entries(FIELDS)) {
    if (out[key] === undefined || out[key] === null || out[key] === '') {
      delete out[key];
      continue;
    }
    if (field.kind === 'date') {
      const formatted = toFormDate(out[key]);
      // Leave an unparseable date in place so validation can name it.
      out[key] = formatted ?? String(out[key]);
    } else if (typeof out[key] === 'string') {
      out[key] = out[key].trim();
    }
  }
}

/** Applies the defaults and Yes/No wording for the radio questions. */
function normalizeRadios(out) {
  for (const [key, group] of Object.entries(RADIO_GROUPS)) {
    if (out[key] === undefined && group.default) {
      out[key] = group.default;
    }
    if (typeof out[key] === 'boolean') {
      out[key] = out[key] ? 'Yes' : 'No';
    }
  }
}

export function normalizeApplicant(input) {
  const out = { ...input };

  normalizeFields(out);

  for (const key of ['surname', 'givenName']) {
    if (out[key]) {
      out[key] = normalizeName(out[key]);
    }
  }

  if (out.email && !out.confirmEmail) {
    out.confirmEmail = out.email;
  }

  // Rewrite dropdown values to the site's exact wording, so everyday phrasing
  // and the instruction page's names both select the right option.
  if (out.purpose) {
    out.purpose = canonicalPurpose(out.purpose);
  }
  for (const key of ['entryBorderGate', 'exitBorderGate']) {
    if (out[key]) {
      out[key] = canonicalBorderGate(out[key]);
    }
  }

  normalizeRadios(out);

  // Fill the required fields that have one answer nearly everyone gives, so the
  // applicant is not asked for something the form can assume.
  for (const [key, value] of Object.entries(FIELD_DEFAULTS)) {
    out[key] ??= value;
  }

  applyDateDefaults(out);

  return out;
}

/**
 * Fills the trip dates that follow from one another.
 *
 * An applicant who has not named a date is usually planning some weeks ahead,
 * so entry defaults to seven weeks out. The validity window then runs from that
 * date for the full 90 days the visa allows, since a shorter window only limits
 * the applicant and costs the same.
 */
function applyDateDefaults(out) {
  const entry = parseDate(out.entryDate) ?? addDays(today(), 7 * 7);
  out.entryDate ??= toFormDate(entry);

  const from = parseDate(out.validFrom) ?? entry;
  out.validFrom ??= toFormDate(from);

  // The window is inclusive of both ends, so the last day is 89 days on.
  out.validTo ??= toFormDate(addDays(from, MAX_EVISA_DAYS - 1));
}

/** A date the given number of days after another, in UTC. */
function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

/** Today at UTC midnight; the site works in UTC+07:00 and compares whole days. */
function today() {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

/** Flags any date the form would reject for already having passed. */
function checkPastDates({ from, to, entry }, errors) {
  const now = today();
  // The form rejects a validity window that starts in the past outright, so
  // catch it here and explain why before the site refuses the application.
  if (from && from < now) {
    errors.push('validFrom is in the past; the form requires today or later');
  }
  if (to && to < now) {
    errors.push('validTo is in the past');
  }
  if (entry && entry < now) {
    errors.push('entryDate is in the past');
  }
}

/** Checks the requested validity window and the entry date inside it. */
function checkWindow({ from, to, entry }, errors) {
  if (from && to) {
    if (to < from) {
      errors.push('validTo is before validFrom');
    } else if (inclusiveDays(from, to) > MAX_EVISA_DAYS) {
      errors.push(
        `e-visa validity must not exceed ${MAX_EVISA_DAYS} days (got ${inclusiveDays(from, to)})`
      );
    }
  }
  if (entry && from && entry < from) {
    errors.push('entryDate is before the requested validity start');
  }
  if (entry && to && entry > to) {
    errors.push('entryDate is after the requested validity end');
  }
}

function checkDates(data, errors, warnings) {
  const dates = {
    entry: parseDate(data.entryDate),
    from: parseDate(data.validFrom),
    to: parseDate(data.validTo),
  };
  const expiry = parseDate(data.passportExpiryDate);
  const birth = parseDate(data.dateOfBirth);

  checkPastDates(dates, errors);
  checkWindow(dates, errors);

  // The Immigration Department requires the passport to outlast the stay; six
  // months of remaining validity is the widely applied threshold.
  if (expiry && dates.entry) {
    const sixMonths = new Date(dates.entry.getTime());
    sixMonths.setUTCMonth(sixMonths.getUTCMonth() + 6);
    if (expiry < sixMonths) {
      warnings.push(
        'passport expires less than 6 months after the intended entry date'
      );
    }
  }
  if (birth && birth > new Date()) {
    errors.push('dateOfBirth is in the future');
  }
}

/**
 * Validates a normalized applicant record. Returns every problem at once so a
 * user can fix a whole form in a single pass.
 */
/** Checks each field is present, short enough, and a real date where required. */
function checkFields(data, errors) {
  for (const [key, field] of Object.entries(FIELDS)) {
    const value = data[key];
    if (field.required && !value) {
      errors.push(`missing required field: ${key}`);
      continue;
    }
    if (!value) {
      continue;
    }
    if (field.max && String(value).length > field.max) {
      errors.push(
        `${key} exceeds the form limit of ${field.max} characters (got ${String(value).length})`
      );
    }
    // Check the shape and that it is a real calendar day: a value like
    // 31/02/1990 matches the pattern but is not a date.
    if (
      field.kind === 'date' &&
      (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(value)) || !parseDate(value))
    ) {
      errors.push(`${key} is not a valid date: ${value}`);
    }
  }
}

/** Checks the values that have to match one of a fixed set of options. */
function checkChoices(data, errors, warnings) {
  for (const [key, group] of Object.entries(RADIO_GROUPS)) {
    if (data[key] !== undefined && !group.options.includes(data[key])) {
      errors.push(
        `${key} must be one of ${group.options.join(', ')} (got ${data[key]})`
      );
    }
  }

  for (const key of ['entryBorderGate', 'exitBorderGate']) {
    const gate = data[key];
    // Only air gates are cross-checked; land and sea gates are accepted as
    // typed because there are 79 of them and their names vary across the site.
    if (
      gate &&
      /airport/i.test(gate) &&
      !AIR_BORDER_GATES.some((g) => g.toLowerCase() === gate.toLowerCase())
    ) {
      warnings.push(
        `${key} does not match an airport in the form's list: ${gate}`
      );
    }
  }
}

export function validateApplicant(data) {
  const errors = [];
  const warnings = [];

  checkFields(data, errors);

  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    errors.push(`email is not a valid address: ${data.email}`);
  }
  if (data.email && data.confirmEmail && data.email !== data.confirmEmail) {
    errors.push('email and confirmEmail differ');
  }

  checkChoices(data, errors, warnings);

  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key) && !key.startsWith('_')) {
      warnings.push(`unknown field ignored: ${key}`);
    }
  }

  if (data.purpose && !PURPOSES.includes(data.purpose)) {
    warnings.push(
      `purpose "${data.purpose}" is not one of ${PURPOSES.join(', ')}`
    );
  }

  checkDates(data, errors, warnings);

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Merges records from several sources. Later sources win, but only where they
 * actually carry a value, so a verified override can sit on top of raw OCR
 * without erasing the fields it does not mention.
 */
export function mergeSources(...sources) {
  const out = {};
  const provenance = {};
  for (const source of sources) {
    if (!source || !source.data) {
      continue;
    }
    for (const [key, value] of Object.entries(source.data)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      out[key] = value;
      provenance[key] = source.name || 'unknown';
    }
  }
  return { data: out, provenance };
}
