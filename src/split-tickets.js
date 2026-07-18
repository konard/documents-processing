#!/usr/bin/env node
// split-tickets.js
//
// Extracts the English e-tickets from a multi-passenger booking PDF and writes
// one PDF per passenger, containing exactly that passenger's ticket pages: the
// "Electronic ticket (route/receipt)" page that names the passenger plus every
// following continuation page, up to the next ticket / section.
//
// Output files are named  <FULL-NAME>-TICKET.pdf  (uppercase, hyphenated),
// matching the visa file naming style.
//
// Some bookings glue two given-name parts together in the header (e.g. a double
// first name printed with no space). Supply a JSON de-glue map with
// --glued=<file.json> — { "<GLUEDTOKEN>": "<TWO WORDS>" } — to split them back
// apart so filenames stay consistent. Without it, names are used verbatim.
//
// Usage:  node split-tickets.js <input.pdf> [outputDir] [--glued=<file.json>]

import fs from 'node:fs';
import path from 'node:path';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';

// ---- args -----------------------------------------------------------------

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const flags = process.argv.slice(2).filter((arg) => arg.startsWith('--'));

const INPUT = positional[0];
if (!INPUT) {
  console.error(
    'Usage: node split-tickets.js <input.pdf> [outputDir] [--glued=<file.json>]'
  );
  process.exit(1);
}
const OUT_DIR = positional[1] || path.dirname(path.resolve(INPUT));

// Optional de-glue map for names printed without a separating space.
const gluedFlag = flags.find((flag) => flag.startsWith('--glued='));
const GLUED = gluedFlag
  ? JSON.parse(fs.readFileSync(gluedFlag.slice('--glued='.length), 'utf8'))
  : {};

// Marker that starts an English ticket page (the passenger header page).
const TICKET_START = 'Electronic ticket (route/receipt)';
// Markers that mean "the ticket section is over" — anything after these is not
// part of a passenger's ticket.
const SECTION_END_MARKERS = ['Additional services', 'Order details'];

// A passenger name on a ticket header looks like  "Ticket number  NAME  <digits>".
// Names are printed in UPPERCASE latin letters (possibly with spaces).
function extractPassengerName(text) {
  const m = text.match(/Ticket number\s+([A-Z][A-Z ]+?)\s+\d{6,}/);
  return m ? m[1].trim() : null;
}

// ---- extract text per page ------------------------------------------------

const data = new Uint8Array(fs.readFileSync(INPUT));
const doc = await getDocument({ data }).promise;
const numPages = doc.numPages;

const pageText = [];
for (let i = 1; i <= numPages; i++) {
  const page = await doc.getPage(i);
  const content = await page.getTextContent();
  const text = content.items
    .map((it) => it.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  pageText.push(text);
}

// ---- find English ticket boundaries ---------------------------------------

const isTicketStart = (t) => t.includes(TICKET_START);
const isSectionEnd = (t) => SECTION_END_MARKERS.some((m) => t.includes(m));

// Collect ticket groups: each starts at an English ticket header page and runs
// until (but not including) the next ticket header or the end-of-section marker.
const tickets = [];
for (let i = 0; i < numPages; i++) {
  if (!isTicketStart(pageText[i])) {
    continue;
  }
  const name = extractPassengerName(pageText[i]);
  const start = i; // 0-based page index
  let end = i; // inclusive
  for (let j = i + 1; j < numPages; j++) {
    if (isTicketStart(pageText[j]) || isSectionEnd(pageText[j])) {
      break;
    }
    end = j;
  }
  tickets.push({ name, start, end });
}

if (tickets.length === 0) {
  console.error('No English tickets found. Nothing to do.');
  process.exit(1);
}

// ---- helpers --------------------------------------------------------------

// "SURNAME GIVEN" -> "SURNAME-GIVEN". A glued given-name token is split back
// apart via the supplied --glued map so the filename matches the visa naming.
function toFilenameBase(name) {
  const parts = name
    .split(/\s+/)
    .map((p) => GLUED[p] || p)
    .join(' ')
    .trim();
  return parts.replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '');
}

// ---- write one PDF per ticket ---------------------------------------------

const srcBytes = fs.readFileSync(INPUT);
const written = [];

for (const t of tickets) {
  const src = await PDFDocument.load(srcBytes);
  const out = await PDFDocument.create();
  const indices = [];
  for (let p = t.start; p <= t.end; p++) {
    indices.push(p);
  }
  const copied = await out.copyPages(src, indices);
  copied.forEach((pg) => out.addPage(pg));

  const base = t.name ? toFilenameBase(t.name) : `PASSENGER-${t.start + 1}`;
  const fileName = `${base}-TICKET.pdf`;
  const outPath = path.join(OUT_DIR, fileName);
  fs.writeFileSync(outPath, await out.save());

  const pageCount = t.end - t.start + 1;
  written.push({
    fileName,
    pages: `${t.start + 1}-${t.end + 1}`,
    pageCount,
    name: t.name,
  });
  console.log(
    `✓ ${fileName}  (passenger: ${t.name}, source pages ${t.start + 1}-${t.end + 1}, ${pageCount} page${pageCount > 1 ? 's' : ''})`
  );
}

console.log(`\nDone. Wrote ${written.length} ticket PDF(s) to:\n  ${OUT_DIR}`);
