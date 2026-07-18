#!/usr/bin/env node
// join-visa-ticket.js
//
// For each passenger, joins their visa and ticket into a single PDF:
//   - page 1  = the visa (first page of <NAME>-VISA.pdf)
//   - pages 2+ = all pages of <NAME>-TICKET.pdf
//
// Pairs are matched by the shared <NAME> prefix of the *-VISA.pdf and
// *-TICKET.pdf files in the folder. Output is  <NAME>-VISA-AND-TICKET.pdf
//
// Usage:  node join-visa-ticket.js [dir]
//
// Requires: pdf-lib  (npm dependency).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config ---------------------------------------------------------------

// Scripts live in src/; documents live one level up in the project root.
const DIR = process.argv[2] || path.dirname(__dirname);
const VISA_SUFFIX = '-VISA.pdf';
const TICKET_SUFFIX = '-TICKET.pdf';
const OUT_SUFFIX = '-VISA-AND-TICKET.pdf';

// ---- pair visas with tickets by shared name prefix ------------------------

const files = fs.readdirSync(DIR);
const visas = new Map(); // NAME -> filename
const tickets = new Map(); // NAME -> filename

for (const f of files) {
  if (f.endsWith(VISA_SUFFIX)) {
    visas.set(f.slice(0, -VISA_SUFFIX.length), f);
  } else if (f.endsWith(TICKET_SUFFIX)) {
    tickets.set(f.slice(0, -TICKET_SUFFIX.length), f);
  }
}

const names = [...visas.keys()].filter((n) => tickets.has(n)).sort();

// Warn about any unpaired files so nothing is silently skipped.
for (const n of visas.keys()) {
  if (!tickets.has(n)) {
    console.warn(`⚠ visa without ticket: ${visas.get(n)}`);
  }
}
for (const n of tickets.keys()) {
  if (!visas.has(n)) {
    console.warn(`⚠ ticket without visa: ${tickets.get(n)}`);
  }
}

if (names.length === 0) {
  console.error('No matching VISA + TICKET pairs found. Nothing to do.');
  process.exit(1);
}

// ---- build the combined PDFs ----------------------------------------------

for (const name of names) {
  const visaPath = path.join(DIR, visas.get(name));
  const ticketPath = path.join(DIR, tickets.get(name));

  const out = await PDFDocument.create();

  // Page 1: the visa (first page only).
  const visaDoc = await PDFDocument.load(fs.readFileSync(visaPath));
  const [visaPage] = await out.copyPages(visaDoc, [0]);
  out.addPage(visaPage);

  // Pages 2+: all ticket pages.
  const ticketDoc = await PDFDocument.load(fs.readFileSync(ticketPath));
  const ticketPages = await out.copyPages(
    ticketDoc,
    ticketDoc.getPageIndices()
  );
  ticketPages.forEach((pg) => out.addPage(pg));

  const outName = `${name}${OUT_SUFFIX}`;
  fs.writeFileSync(path.join(DIR, outName), await out.save());
  console.log(
    `✓ ${outName}  (visa p1 + ${ticketPages.length} ticket page${ticketPages.length > 1 ? 's' : ''} = ${out.getPageCount()} pages)`
  );
}

console.log(`\nDone. Wrote ${names.length} combined PDF(s) to:\n  ${DIR}`);
