#!/usr/bin/env node
// first-page-tickets.mjs
//
// Turns a folder of per-passenger e-ticket PDFs (one booking each, several
// pages long — itinerary/receipt, terms, fare rules …) into a folder of
// single-page tickets, keeping only the first page of every PDF.
//
// Each output is named after the passenger printed inside the ticket (not the
// input filename), so the result matches the visa naming style:
//
//   <SURNAME>-<GIVEN...>-TICKET.pdf   (uppercase, hyphenated)
//
// The passenger appears on the first page as  "PASSENGER: SURNAME GIVEN <title>".
// Some bookings glue a double given name together with no separating space
// (e.g. "ANNAMARIA" for "ANNA MARIA"). Supply a JSON de-glue map with
// --glued=<file.json> — { "<GLUEDTOKEN>": "<TWO WORDS>" } — to split them back
// apart so filenames stay consistent. Without it, names are used verbatim.
//
// Usage:  node first-page-tickets.mjs <inputDir> [outputDir] [--glued=<file.json>]
//         node first-page-tickets.mjs <inputDir> [outputDir] --pages=1
//
// --pages=<n> keeps the first n pages (default 1 = first page only).
//
// Requires: pdfjs-dist, pdf-lib  (npm dependencies).

import fs from 'node:fs';
import path from 'node:path';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';

// ---- args -----------------------------------------------------------------

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const flags = process.argv.slice(2).filter((arg) => arg.startsWith('--'));

const INPUT_DIR = positional[0];
if (!INPUT_DIR) {
  console.error(
    'Usage: node first-page-tickets.mjs <inputDir> [outputDir] [--glued=<file.json>] [--pages=<n>]'
  );
  process.exit(1);
}
const OUT_DIR =
  positional[1] || path.join(path.dirname(path.resolve(INPUT_DIR)), 'tickets');

// How many leading pages to keep from each input PDF (default: 1).
const pagesFlag = flags.find((flag) => flag.startsWith('--pages='));
const KEEP_PAGES = Math.max(
  1,
  parseInt(pagesFlag?.slice('--pages='.length), 10) || 1
);

// Optional de-glue map for names printed without a separating space.
const gluedFlag = flags.find((flag) => flag.startsWith('--glued='));
const GLUED = gluedFlag
  ? JSON.parse(fs.readFileSync(gluedFlag.slice('--glued='.length), 'utf8'))
  : {};

// Titles/suffixes printed after the name that are not part of it.
const NAME_STOP = /\b(?:MR|MRS|MS|MSTR|MISS|DR|CHD|INF|ADT|BOOKING|TICKET)\b/;

// The passenger appears as  "PASSENGER: SURNAME GIVEN [MORE] <title/stop>".
function extractPassengerName(text) {
  const m = text.match(
    /PASSENGER:\s+(.+?)\s+(?=(?:MR|MRS|MS|MSTR|MISS|DR|CHD|INF|ADT|BOOKING|TICKET)\b)/
  );
  if (m) {
    return m[1].trim();
  }
  // Fallback: take the words after PASSENGER: up to the first stop word.
  const loose = text.match(/PASSENGER:\s+([A-Z][A-Z ]+)/);
  if (!loose) {
    return null;
  }
  return loose[1].split(NAME_STOP)[0].trim().replace(/\s+/g, ' ');
}

// "SURNAME GIVEN" -> "SURNAME-GIVEN". A glued given-name token is split back
// apart via the supplied --glued map so the filename matches the visa naming.
function toFilenameBase(name) {
  return name
    .split(/\s+/)
    .map((part) => GLUED[part] || part)
    .join(' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9-]/g, '');
}

// ---- read passenger name from a PDF's first page --------------------------

async function firstPageText(bytes) {
  const doc = await getDocument({ data: new Uint8Array(bytes) }).promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  return content.items
    .map((it) => it.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- process every PDF in the input folder --------------------------------

const inputs = fs
  .readdirSync(INPUT_DIR)
  .filter((f) => f.toLowerCase().endsWith('.pdf'))
  .sort();

if (inputs.length === 0) {
  console.error(`No PDF files found in ${INPUT_DIR}. Nothing to do.`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

let count = 0;
for (const file of inputs) {
  const srcBytes = fs.readFileSync(path.join(INPUT_DIR, file));
  const text = await firstPageText(srcBytes);
  const name = extractPassengerName(text);

  const src = await PDFDocument.load(srcBytes);
  const out = await PDFDocument.create();
  const keep = Math.min(KEEP_PAGES, src.getPageCount());
  const indices = Array.from({ length: keep }, (_, i) => i);
  const copied = await out.copyPages(src, indices);
  copied.forEach((pg) => out.addPage(pg));

  const base = name
    ? toFilenameBase(name)
    : path.basename(file, path.extname(file));
  const fileName = `${base}-TICKET.pdf`;
  fs.writeFileSync(
    path.join(OUT_DIR, fileName),
    await out.save({ useObjectStreams: false })
  );

  count++;
  console.log(
    `✓ ${file}  ->  ${fileName}  (passenger: ${name || '(from filename)'}, kept ${keep} page${keep > 1 ? 's' : ''})`
  );
}

console.log(
  `\nDone. Wrote ${count} single-page ticket PDF(s) to:\n  ${OUT_DIR}`
);
