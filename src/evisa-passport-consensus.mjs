// evisa-passport-consensus.mjs
//
// Reads a passport's data page with several OCR engines over several
// renderings of the image, in parallel, and keeps what they agree on.
//
// Every value on the page is printed twice: once in the machine-readable
// zone, once in the print above it, and the print carries what the zone
// cannot, a hyphen in a name, the issue date, the place of birth, the
// authority. No engine reads all of it right on every photo, but their
// errors fall in different places, so a value reached by two of them from
// different places on the page is trustworthy, and a value they split on is
// for a person to settle, not for the form.
//
// The cheap engines run first; the slow one is called only when something is
// still unsettled after them. Each engine is retried once on a failure and
// held to a time budget, so one hung process cannot stall a reading.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { findMrzLines } from './mrz-readers.mjs';
import { parseMrzLine1, parseMrzLine2 } from './mrz-lib.mjs';
import { countryName, sexLabel } from './evisa-schema.mjs';
import { normalizeName } from './evisa-data.mjs';
import { editDistance } from './translit.mjs';
import { isKnownPlace } from './evisa-home-address.mjs';
import {
  readPassportMrz,
  readPassportPage,
  placeWords,
  cleanAuthorityBody,
  cleanAuthorityCode,
  cleanConsularAuthority,
} from './evisa-passport.mjs';

const run = promisify(execFile);

/** The fields a reading may settle, in the order they are reported. */
export const CONSENSUS_FIELDS = [
  'passportNumber',
  'dateOfBirth',
  'passportExpiryDate',
  'sex',
  'nationality',
  'surname',
  'givenName',
  'passportIssueDate',
  'placeOfBirth',
  'passportIssuingAuthority',
];

/** The fields the zone's check digits vouch for. */
const CHECKED_FIELDS = new Set([
  'passportNumber',
  'dateOfBirth',
  'passportExpiryDate',
]);

const NAME_FIELDS = new Set(['surname', 'givenName']);

const engineDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'ocr-engines'
);

/**
 * The engines that read a whole page as lines of text, each a Python
 * script that prints {"lines": [...]}. `cost` puts the slow one in the
 * second tier.
 */
const PAGE_ENGINES = [
  {
    name: 'vision',
    script: 'vision-ocr.py',
    check: 'import Vision, Quartz',
    cost: 'fast',
    timeout: 60_000,
  },
  {
    name: 'rapid',
    script: 'rapid-ocr.py',
    check: 'from rapidocr_onnxruntime import RapidOCR',
    cost: 'fast',
    timeout: 90_000,
  },
  {
    name: 'paddle',
    script: 'paddle-ocr.py',
    check: 'from paddleocr import PaddleOCR',
    cost: 'slow',
    timeout: 180_000,
  },
];

const availability = new Map();

/** True when an engine's Python side imports, checked once per process. */
function isAvailable(engine) {
  if (!availability.has(engine.name)) {
    availability.set(
      engine.name,
      run('python3', ['-c', engine.check], { timeout: 90_000 }).then(
        () => true,
        () => false
      )
    );
  }
  return availability.get(engine.name);
}

/**
 * The renderings of the page each engine reads: the photo as it is, a
 * grey enlarged copy with its contrast stretched, and the dark ink alone
 * with the coloured security pattern dropped. An engine that stumbles on
 * one often reads another cleanly.
 */
export async function renderVariants(imagePath, dir) {
  const { default: sharp } = await import('sharp');
  const meta = await sharp(imagePath).metadata();
  const width = Math.max(meta.width ?? 0, 1600);
  const variants = [{ name: 'original', path: imagePath }];
  const gray = path.join(dir, 'gray.png');
  await sharp(imagePath)
    .rotate()
    .resize({ width, withoutEnlargement: false })
    .grayscale()
    .normalise()
    .png()
    .toFile(gray);
  variants.push({ name: 'gray', path: gray });
  const ink = path.join(dir, 'ink.png');
  await sharp(imagePath)
    .rotate()
    .resize({ width, withoutEnlargement: false })
    .grayscale()
    .threshold(150)
    .png()
    .toFile(ink);
  variants.push({ name: 'ink', path: ink });
  return variants;
}

/** Runs an engine on an image, once more on a failure; lines or a throw. */
async function readLines(engine, imagePath, { attempts = 2 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { stdout } = await run(
        'python3',
        [path.join(engineDir, engine.script), imagePath],
        { timeout: engine.timeout, maxBuffer: 16 * 1024 * 1024 }
      );
      const { lines } = JSON.parse(stdout.trim().split('\n').pop());
      return (lines ?? []).map((line) => String(line));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** A date printed as dd.mm.yyyy, with any separator, as ISO; null if not one. */
function isoDate(day, month, year) {
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) {
    return null;
  }
  return `${year}-${month}-${day}`;
}

/** Words that stand in labels and headings, never in a name. */
const NOT_A_NAME = new Set([
  'RUSSIAN',
  'FEDERATION',
  'PASSPORT',
  'TYPE',
  'SURNAME',
  'GIVEN',
  'NAMES',
  'NAME',
  'NATIONALITY',
  'SEX',
  'DATE',
  'OF',
  'BIRTH',
  'PLACE',
  'AUTHORITY',
  'ISSUE',
  'EXPIRY',
  'CODE',
  'STATE',
  'ISSUING',
  'HOLDER',
  'HOLDERS',
  'SIGNATURE',
  'PERSONAL',
  'NO',
  'RUS',
  'P',
  'M',
  'F',
]);

/** The zone's fields from a page's lines, or null when the page has none. */
function zoneFromLines(lines) {
  const mrz = findMrzLines(lines);
  if (!mrz) {
    return null;
  }
  const line2 = parseMrzLine2(mrz[1]);
  if (!line2) {
    return null;
  }
  const line1 = parseMrzLine1(mrz[0]);
  const fields = {
    passportNumber: line2.passportNumber,
    dateOfBirth: line2.dob,
    passportExpiryDate: line2.expiry,
    nationality: countryName(line2.nationality),
    sex: sexLabel(line2.sex),
  };
  if (line1) {
    fields.surname = normalizeName(line1.surname, { fromOcr: true });
    fields.givenName = normalizeName(line1.given, { fromOcr: true });
  }
  for (const key of Object.keys(fields)) {
    if (!fields[key]) {
      delete fields[key];
    }
  }
  return {
    fields,
    valid: {
      passportNumber: line2.passportCheckOk,
      dateOfBirth: line2.dobCheckOk,
      passportExpiryDate: line2.expiryCheckOk,
    },
  };
}

/** A name as printed, in capitals with hyphens kept, or null. */
function printedName(line) {
  const text = line.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!/^[A-Z][A-Z' -]{1,40}$/.test(text) || /<|\d/.test(line)) {
    return null;
  }
  const words = text.split(/[\s-]+/).filter(Boolean);
  if (!words.length || words.some((word) => NOT_A_NAME.has(word))) {
    return null;
  }
  return text;
}

/** True when a printed name is the zone's name, hyphens aside. */
function sameName(printed, zone) {
  if (!printed || !zone) {
    return false;
  }
  const flat = (name) => name.replace(/[-\s]/g, '');
  return editDistance(flat(printed), flat(zone)) <= 1;
}

/**
 * The three dates on the page told apart: the birth date and the expiry
 * are the zone's, and the issue date is the one between them, nearest to
 * five or ten years before the expiry, which is how long a passport runs.
 */
function assignDates(dates, zone) {
  const found = {};
  const unique = [...new Set(dates)];
  const pick = (iso) => (iso && unique.includes(iso) ? iso : null);
  found.dateOfBirth = pick(zone?.dateOfBirth);
  found.passportExpiryDate = pick(zone?.passportExpiryDate);
  const rest = unique.filter(
    (date) => date !== found.dateOfBirth && date !== found.passportExpiryDate
  );
  if (!found.dateOfBirth && rest.length) {
    found.dateOfBirth = rest.shift();
  }
  if (!found.passportExpiryDate && rest.length) {
    found.passportExpiryDate = rest.pop();
  }
  const expiry = found.passportExpiryDate;
  const between = rest.filter(
    (date) =>
      (!found.dateOfBirth || date > found.dateOfBirth) &&
      (!expiry || date < expiry)
  );
  if (between.length && expiry) {
    const yearsBefore = (date) =>
      Number(expiry.slice(0, 4)) - Number(date.slice(0, 4));
    between.sort(
      (a, b) =>
        Math.min(Math.abs(yearsBefore(a) - 5), Math.abs(yearsBefore(a) - 10)) -
        Math.min(Math.abs(yearsBefore(b) - 5), Math.abs(yearsBefore(b) - 10))
    );
  }
  found.passportIssueDate = between[0] ?? null;
  return found;
}

/** The place of birth in a line, as "<native>/<Latin>", or null. */
function placeInLine(line) {
  if (line.includes('<')) {
    return null;
  }
  // The birth date is printed beside the place, and an engine may put both
  // on one line; a slash read as an L glues on to the country.
  const text = line
    .replace(/\d{2}[.,/:;-]?\d{2}[.,/:;-]\d{4}/g, ' ')
    .replace(/\bL(?=[A-Z]{4,})/g, ' ')
    // What is left with a digit in it is the date misread, not the place.
    .replace(/\S*\d\S*/g, ' ');
  const { native, latin } = placeWords(text);
  const known = native.filter((word) => isKnownPlace(word));
  const nativeHalf = known[0] ?? null;
  const latinHalf = latin[0] ?? null;
  if (!nativeHalf && !latinHalf) {
    return null;
  }
  return [nativeHalf, latinHalf].filter(Boolean).join('/');
}

/** The issuing authority in a line: a body with its code, or a consulate. */
function authorityInLine(line) {
  const body = cleanAuthorityBody(line);
  const code = cleanAuthorityCode(line.replace(/[^\dOО]/g, ''));
  if (body && code) {
    return `${body} ${code}`;
  }
  return cleanConsularAuthority(line);
}

/** Notes the dates, the number and the sex a line carries. */
function noteValues(line, print, dates) {
  // Engines vary the separators, "08/08.2024", "08.08-2029", and drop one
  // now and then, "0808.2024"; the digits are what count.
  for (const match of line.matchAll(
    /(\d{2})[.,/:;-]?(\d{2})[.,/:;-](\d{4})/g
  )) {
    const iso = isoDate(match[1], match[2], match[3]);
    if (iso) {
      dates.push(iso);
    }
  }
  const number = line
    .replace(/\s+/g, '')
    .match(/(\d{2})(?:№|N[oº°:]?|#)(\d{7})(?!\d)/i);
  if (number && !print.passportNumber) {
    print.passportNumber = number[1] + number[2];
  }
  const sex = line.match(/^\s*([МЖMF])\s*[/|]\s*([MF])\s*$/i);
  if (sex) {
    print.sex = sexLabel(sex[2].toUpperCase());
  }
}

/**
 * Notes a name a line carries: the one under the label just read, or one
 * that is the zone's name, hyphens aside, when no label was seen.
 */
function noteName(line, print, zone, expect) {
  const name = printedName(line);
  if (!name) {
    return;
  }
  if (expect.surname && !print.surname) {
    print.surname = name;
  } else if (expect.given && !print.givenName) {
    print.givenName = name;
  } else if (!print.surname && sameName(name, zone?.fields.surname)) {
    print.surname = name;
  } else if (!print.givenName && sameName(name, zone?.fields.givenName)) {
    print.givenName = name;
  }
}

/** Notes a place of birth or an authority a line carries. */
function notePlaceAndAuthority(line, print, expect) {
  if (!print.placeOfBirth) {
    const place = placeInLine(line);
    // Under its label either half will do; elsewhere on the page only a
    // line naming both halves, "МОСКВА/USSR", is surely the place.
    if (place && (expect.place || place.includes('/'))) {
      print.placeOfBirth = place;
    }
  }
  if (!print.passportIssuingAuthority) {
    const authority = authorityInLine(line);
    // A body with its code is taken only under its label; a consulate's
    // wording is its own label.
    if (
      authority &&
      (expect.authority || /^(?:Г\/К|ПОСОЛЬСТВО)/.test(authority))
    ) {
      print.passportIssuingAuthority = authority;
    }
  }
}

/** What the labels on a line say the next line holds. */
function labelsOn(line, expect, print) {
  const label = line.toLowerCase();
  return {
    surname: /surname|фамилия/.test(label),
    given: /given|имя/.test(label),
    place:
      /place of birth|место рождения/.test(label) ||
      (expect.place && !print.placeOfBirth && !/date|дата/.test(label)),
    authority: /authority|орган/.test(label),
  };
}

/**
 * Everything a page's lines say, from the zone and from the print,
 * separately, so the two can be checked against each other.
 */
export function fieldsFromLines(lines) {
  const zone = zoneFromLines(lines);
  const print = {};
  const dates = [];
  let expect = { surname: false, given: false, place: false, authority: false };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    noteValues(line, print, dates);
    noteName(line, print, zone, expect);
    notePlaceAndAuthority(line, print, expect);
    expect = labelsOn(line, expect, print);
  }

  Object.assign(print, assignDates(dates, zone?.fields));
  for (const key of Object.keys(print)) {
    if (!print[key]) {
      delete print[key];
    }
  }
  return { zone, print };
}

/** The key two readings of a field share when they say the same thing. */
function groupKey(field, value) {
  const text = String(value).trim();
  if (NAME_FIELDS.has(field)) {
    return text.toUpperCase().replace(/[-\s]/g, '');
  }
  return text.toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Combines every reading of a field into the value they agree on.
 *
 * Each reading is a vote; a zone reading whose check digit holds counts
 * double, since the digit is a second, independent witness. A value wins
 * with two votes or more and a clear lead. Two readings of a name that
 * differ only by a hyphen are one value, reported with the hyphen, since
 * the zone cannot carry one and the print can.
 */
export function settle(votes) {
  const groups = new Map();
  // A place one letter apart is one reading; a code one digit apart is not.
  const fuzzy = (field, key) =>
    !CHECKED_FIELDS.has(field) && !NAME_FIELDS.has(field) && !/\d/.test(key);
  for (const vote of votes) {
    let key = groupKey(vote.field, vote.value);
    if (fuzzy(vote.field, key) && !groups.has(key)) {
      // A place or an authority one misread letter apart is one reading:
      // "ОСКВА/USSR" is "МОСКВА/USSR" with its first letter lost.
      const near = [...groups.keys()].find(
        (other) =>
          Math.min(other.length, key.length) >= 5 &&
          editDistance(other, key) <= 1
      );
      key = near ?? key;
    }
    const group = groups.get(key) ?? {
      value: vote.value,
      weight: 0,
      sources: [],
      seen: new Map(),
    };
    group.seen.set(vote.value, (group.seen.get(vote.value) ?? 0) + vote.weight);
    group.weight += vote.weight;
    group.sources.push(vote.source);
    // The group speaks with its best-supported spelling; a hyphenated one
    // wins among names, since only the print can carry the hyphen.
    group.value = [...group.seen.entries()].sort(
      (a, b) =>
        Number(b[0].includes('-')) - Number(a[0].includes('-')) ||
        b[1] - a[1] ||
        b[0].length - a[0].length
    )[0][0];
    groups.set(key, group);
  }
  const ranked = [...groups.values()].sort((a, b) => b.weight - a.weight);
  if (!ranked.length) {
    return { status: 'unread', candidates: [] };
  }
  const [best, runnerUp] = ranked;
  if (best.weight >= 2 && (!runnerUp || runnerUp.weight < best.weight)) {
    return {
      status: 'agreed',
      value: best.value,
      votes: best.weight,
      sources: best.sources,
      candidates: ranked,
    };
  }
  if (ranked.length === 1) {
    return {
      status: 'weak',
      value: best.value,
      votes: best.weight,
      sources: best.sources,
      candidates: ranked,
    };
  }
  return { status: 'disputed', candidates: ranked };
}

/** Turns one engine's reading of one rendering into votes. */
function votesFrom(reading) {
  const votes = [];
  const { zone, print, source } = reading;
  if (zone) {
    for (const [field, value] of Object.entries(zone.fields)) {
      const checked = CHECKED_FIELDS.has(field) && zone.valid[field];
      votes.push({
        field,
        value,
        weight: checked ? 2 : 1,
        source: `${source}/zone`,
      });
    }
  }
  for (const [field, value] of Object.entries(print ?? {})) {
    votes.push({ field, value, weight: 1, source: `${source}/print` });
  }
  return votes;
}

/** The consensus over a set of readings, field by field. */
export function consensusOf(readings) {
  const votes = readings.flatMap(votesFrom);
  const data = {};
  const agreement = {};
  const disputed = [];
  const weak = [];
  const unread = [];
  for (const field of CONSENSUS_FIELDS) {
    const outcome = settle(votes.filter((vote) => vote.field === field));
    if (outcome.status === 'unread') {
      unread.push(field);
    } else if (outcome.status === 'disputed') {
      disputed.push({
        field,
        candidates: outcome.candidates.map(({ value, weight, sources }) => ({
          value,
          votes: weight,
          sources,
        })),
      });
    } else {
      data[field] = outcome.value;
      agreement[field] = { votes: outcome.votes, sources: outcome.sources };
      if (outcome.status === 'weak') {
        weak.push(field);
      }
    }
  }
  // A number or a date no check digit stood behind is reported, so a caller
  // can ask for a second look.
  const unverified = [...CHECKED_FIELDS].filter(
    (field) =>
      data[field] &&
      !agreement[field].sources.some(
        (source) =>
          source.endsWith('/zone') &&
          votes.some(
            (vote) =>
              vote.field === field &&
              vote.source === source &&
              vote.weight === 2
          )
      )
  );
  return {
    data,
    agreement,
    disputed,
    weak,
    unread,
    unverified,
    complete: disputed.length === 0 && unread.length === 0 && weak.length === 0,
  };
}

/** The tesseract reader, whose strips are a reading like any other. */
async function tesseractReading(imagePath) {
  const mrz = await readPassportMrz(imagePath);
  const page = await readPassportPage(imagePath, mrz.data);
  const zone = mrz.mrzFound
    ? {
        fields: mrz.data,
        valid: {
          passportNumber: !mrz.unverified.includes('passportNumber'),
          dateOfBirth: !mrz.unverified.includes('dateOfBirth'),
          passportExpiryDate: !mrz.unverified.includes('passportExpiryDate'),
        },
      }
    : null;
  const { givenNameAsPrinted, ...print } = page.data;
  if (givenNameAsPrinted) {
    print.givenName = givenNameAsPrinted;
  }
  return { zone, print };
}

/** Runs tasks with at most `limit` in flight at once. */
async function inParallel(tasks, limit) {
  const results = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]();
      }
    }
  );
  await Promise.all(workers);
  return results;
}

/**
 * Reads a passport page with every engine at hand and settles each field
 * by consensus. `log` hears what each engine did and how long it took.
 *
 * Tier one is the fast engines on the photo and its grey rendering, with
 * the tesseract strips beside them; tier two, run only when a field is
 * still open, adds the slow engine and the ink rendering.
 */
export async function readPassportConsensus(
  imagePath,
  { log = () => {} } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-ocr-'));
  const readings = [];
  const attempts = [];
  try {
    const variants = await renderVariants(imagePath, dir);
    const byName = Object.fromEntries(variants.map((v) => [v.name, v]));
    const engines = [];
    for (const engine of PAGE_ENGINES) {
      if (await isAvailable(engine)) {
        engines.push(engine);
      } else {
        log(`engine ${engine.name} is not installed; skipped`);
      }
    }
    const task = (engine, variant) => async () => {
      const started = Date.now();
      const source = `${engine.name}/${variant.name}`;
      try {
        const lines = await readLines(engine, variant.path);
        const { zone, print } = fieldsFromLines(lines);
        readings.push({ source, zone, print });
        attempts.push({
          source,
          ok: true,
          ms: Date.now() - started,
          lines: lines.length,
        });
      } catch (error) {
        attempts.push({
          source,
          ok: false,
          ms: Date.now() - started,
          error: error.message.split('\n')[0],
        });
      }
    };
    const tesseractTask = async () => {
      const started = Date.now();
      try {
        const { zone, print } = await tesseractReading(imagePath);
        readings.push({ source: 'tesseract/strips', zone, print });
        attempts.push({
          source: 'tesseract/strips',
          ok: true,
          ms: Date.now() - started,
        });
      } catch (error) {
        attempts.push({
          source: 'tesseract/strips',
          ok: false,
          ms: Date.now() - started,
          error: error.message.split('\n')[0],
        });
      }
    };
    const fast = engines.filter((engine) => engine.cost === 'fast');
    const slow = engines.filter((engine) => engine.cost === 'slow');
    const limit = Math.max(2, Math.min(6, os.cpus().length - 1));

    const tierOne = [
      ...fast.flatMap((engine) => [
        task(engine, byName.original),
        task(engine, byName.gray),
      ]),
      tesseractTask,
    ];
    await inParallel(tierOne, limit);
    let result = consensusOf(readings);
    log(`tier one: ${describeAttempts(attempts)}`);
    if (!result.complete) {
      const tierTwo = [
        ...slow.flatMap((engine) => [
          task(engine, byName.original),
          task(engine, byName.gray),
        ]),
        ...fast.map((engine) => task(engine, byName.ink)),
      ];
      log(`open after tier one: ${openFields(result).join(', ')}; reading on`);
      await inParallel(tierTwo, limit);
      result = consensusOf(readings);
      log(`tier two: ${describeAttempts(attempts.slice(tierOne.length))}`);
    }
    return { ...result, attempts, readings: readings.length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The fields a result has not settled. */
function openFields(result) {
  return [
    ...result.disputed.map((d) => d.field),
    ...result.weak,
    ...result.unread,
  ];
}

/** One line on what each attempt did. */
function describeAttempts(attempts) {
  return attempts
    .map((a) => `${a.source} ${a.ok ? 'ok' : `failed (${a.error})`} ${a.ms}ms`)
    .join('; ');
}

/** Lines on how each field was settled, for a log. */
export function describeAgreement(result) {
  const lines = [];
  for (const [field, info] of Object.entries(result.agreement)) {
    const weak = result.weak.includes(field) ? ' (one reading only)' : '';
    lines.push(
      `${field}: ${info.votes} votes from ${info.sources.join(', ')}${weak}`
    );
  }
  for (const { field, candidates } of result.disputed) {
    lines.push(
      `${field} DISPUTED: ${candidates.map((c) => `"${c.value}" (${c.votes}: ${c.sources.join(', ')})`).join(' vs ')}`
    );
  }
  for (const field of result.unread) {
    lines.push(`${field}: no reading`);
  }
  return lines;
}
