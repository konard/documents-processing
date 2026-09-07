#!/usr/bin/env node
// mrz-benchmark.mjs
//
// Measures MRZ readers against each other on real passport scans: how long each
// takes, and how often it gets the answer right.
//
// The scans and their expected values stay outside this repository. Point the
// tool at a case file describing them:
//
//   node src/mrz-benchmark.mjs --cases <path-to-cases.json> [--json <out>]
//
// The case file lists an image and the values a person read off the page:
//
//   {
//     "baseDir": "/path/to/documents",
//     "cases": [
//       {
//         "image": "passports-photos/SOMEONE-PASSPORT.jpg",
//         "expected": {
//           "documentNumber": "123456789",
//           "birthDate": "YYYY-MM-DD",
//           "expirationDate": "YYYY-MM-DD",
//           "surname": "DOE",
//           "givenName": "JOHN"
//         }
//       }
//     ]
//   }
//
// Correctness is per field, so a reader that gets four of five right scores
// better than one that fails outright. Timing is wall clock per image: what a
// person actually waits for.

import fs from 'node:fs';
import path from 'node:path';

/** Normalizes a value so formatting differences do not count as errors. */
const norm = (value) =>
  String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/**
 * Normalizes a name for comparison.
 *
 * The MRZ pads every name field with `<` filler, and OCR reads that padding as
 * runs of a repeated letter. Whether a reader strips the padding is a
 * formatting choice, so a reading counts as correct when it starts with the
 * expected name and the rest is filler.
 */
function normName(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}

/** True when `got` is `want` followed only by OCR'd MRZ filler. */
function nameMatches(want, got) {
  const a = normName(want);
  const b = normName(got);
  if (a === b) {
    return true;
  }
  if (!a || !b.startsWith(a)) {
    return false;
  }
  // Whatever follows the name must be a single repeated character to count as
  // padding; real extra names would vary.
  const tail = b.slice(a.length);
  return new Set(tail).size <= 1;
}

/** The fields every reader is scored on. */
export const SCORED_FIELDS = [
  'documentNumber',
  'birthDate',
  'expirationDate',
  'surname',
  'givenName',
];

/**
 * Converts a reader's output to the common shape used for scoring.
 * Dates are compared as digits after normalization, so a six-digit MRZ reading
 * and a full four-digit-year reading are treated alike.
 */
function alignDate(value) {
  const digits = norm(value);
  if (digits.length === 8) {
    return digits;
  }
  if (digits.length === 6) {
    // A two-digit year is ambiguous; compare on the last six digits only.
    return digits;
  }
  return digits;
}

/** Compares one reading against the expected values, field by field. */
export function scoreReading(reading, expected) {
  const fields = {};
  let correct = 0;
  let attempted = 0;

  for (const field of SCORED_FIELDS) {
    const want = expected[field];
    if (want === undefined) {
      continue;
    }
    attempted += 1;
    const got = reading?.[field];
    const isDate = field.endsWith('Date');
    const isName = field === 'surname' || field === 'givenName';
    let match;
    if (isName) {
      match = nameMatches(want, got);
    } else {
      const a = isDate ? alignDate(want) : norm(want);
      const b = isDate ? alignDate(got) : norm(got);
      // A six-digit reading is compared against the tail of the expected date,
      // since the MRZ itself stores only two year digits.
      match = isDate && b.length === 6 ? a.slice(2) === b : a === b;
    }
    fields[field] = { expected: want, got: got ?? null, match };
    if (match) {
      correct += 1;
    }
  }

  return { correct, attempted, fields };
}

/** Runs one reader over every case, timing each call. */
export async function runReader(reader, cases, baseDir) {
  const results = [];
  for (const testCase of cases) {
    const image = path.resolve(baseDir, testCase.image);
    const started = process.hrtime.bigint();
    let reading = null;
    let error = null;
    try {
      reading = await reader.read(image);
    } catch (cause) {
      error = cause.message;
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    results.push({
      image: testCase.image,
      ms,
      error,
      ...scoreReading(reading, testCase.expected),
    });
  }
  return results;
}

/** Totals one reader's results into a single row. */
export function summarize(name, results) {
  const correct = results.reduce((sum, r) => sum + r.correct, 0);
  const attempted = results.reduce((sum, r) => sum + r.attempted, 0);
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const failures = results.filter((r) => r.error).length;
  return {
    reader: name,
    correct,
    attempted,
    accuracy: attempted ? correct / attempted : 0,
    perfectImages: results.filter((r) => r.correct === r.attempted).length,
    images: results.length,
    errors: failures,
    medianMs: times.length ? times[Math.floor(times.length / 2)] : 0,
    totalMs: times.reduce((a, b) => a + b, 0),
  };
}

/** Renders the summary rows as a table. */
export function formatTable(rows) {
  const header = [
    'reader',
    'fields ok',
    'accuracy',
    'clean images',
    'errors',
    'median ms',
    'total ms',
  ];
  const body = rows.map((r) => [
    r.reader,
    `${r.correct}/${r.attempted}`,
    `${(r.accuracy * 100).toFixed(1)}%`,
    `${r.perfectImages}/${r.images}`,
    String(r.errors),
    r.medianMs.toFixed(0),
    r.totalMs.toFixed(0),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length))
  );
  const line = (cells) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...body.map(line),
  ].join('\n');
}

/** Loads the readers that are installed, skipping any that are absent. */
export async function loadReaders() {
  const readers = [];
  const { availableReaders } = await import('./mrz-readers.mjs');
  for (const reader of availableReaders) {
    if (await reader.isAvailable()) {
      readers.push(reader);
    }
  }
  return readers;
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const casesPath = get('--cases');
  if (!casesPath) {
    console.error(
      'Usage: node src/mrz-benchmark.mjs --cases <file> [--json <out>]'
    );
    console.error(
      'See the comment at the top of this file for the case format.'
    );
    process.exit(1);
  }

  const spec = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  const baseDir = spec.baseDir ?? path.dirname(casesPath);
  const readers = await loadReaders();
  if (readers.length === 0) {
    console.error('No readers available. Install at least one and retry.');
    process.exit(1);
  }

  console.log(
    `Benchmarking ${readers.length} reader(s) over ${spec.cases.length} image(s).\n`
  );

  const all = {};
  const rows = [];
  for (const reader of readers) {
    const results = await runReader(reader, spec.cases, baseDir);
    all[reader.name] = results;
    rows.push(summarize(reader.name, results));
  }

  // Score the combination too: engines fail on different fields, so what they
  // agree on is more accurate than any single one of them.
  const { consensus } = await import('./mrz-consensus.mjs');
  const combined = spec.cases.map((testCase, index) => {
    const readings = {};
    let ms = 0;
    for (const reader of readers) {
      const record = all[reader.name][index];
      ms += record.ms;
      readings[reader.name] = Object.fromEntries(
        Object.entries(record.fields).map(([field, f]) => [field, f.got])
      );
    }
    const merged = consensus(readings);
    return {
      image: testCase.image,
      ms,
      error: null,
      disputed: merged.disputed.map((d) => d.field),
      ...scoreReading(merged.data, testCase.expected),
    };
  });
  all['CONSENSUS (all engines)'] = combined;
  rows.push(summarize('CONSENSUS (all engines)', combined));

  rows.sort((a, b) => b.accuracy - a.accuracy || a.medianMs - b.medianMs);
  console.log(formatTable(rows));

  // Name the fields each reader got wrong, so a low score is actionable.
  for (const row of rows) {
    const misses = all[row.reader].flatMap((r) =>
      Object.entries(r.fields)
        .filter(([, f]) => !f.match)
        .map(([field]) => `${path.basename(r.image)}:${field}`)
    );
    if (misses.length) {
      console.log(`\n${row.reader} missed: ${misses.join(', ')}`);
    }
  }

  const jsonOut = get('--json');
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ rows, all }, null, 2));
    console.log(`\nWrote ${jsonOut}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]))
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
