#!/usr/bin/env node
// split-cforms.js
//
// Splits the combined Form 'C' PDF (one page per person) into one
// PDF per person, named  <SURNAME>-<GIVEN...>-FORM-C.pdf  (uppercase, hyphenated)
// to match the rest of our document naming (e.g. <SURNAME>-<GIVEN>-FORM-C.pdf).
//
// The person on each page is read from the page's real text layer
// (Surname / Given name fields) — the source is a text PDF, not a scan — so the
// filename always matches the visa/passport naming without any OCR.
//
// Output goes to  c-forms/<NAME>-FORM-C.pdf
//
// Usage:  node split-cforms.js [input.pdf] [outputDir]
//
// Requires: pdfjs-dist, pdf-lib.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config ---------------------------------------------------------------

// Scripts live in src/; the source PDF and c-forms/ output live one level up in
// the project root.
const projectRoot = path.dirname(__dirname);
const INPUT = process.argv[2] || path.join(projectRoot, 'forms.pdf');
const OUT_DIR = process.argv[3] || path.join(projectRoot, 'c-forms');
const OUT_SUFFIX = '-FORM-C.pdf';

// ---- read the person on each page from its text layer ---------------------

// "<SURNAME>" + "<GIVEN OTHER>"  ->  "<SURNAME>-<GIVEN>-OTHER"
function toFilenameBase(surname, given) {
  return `${surname} ${given}`
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9-]/g, '')
    .toUpperCase();
}

const data = new Uint8Array(fs.readFileSync(INPUT));
const doc = await getDocument({ data }).promise;
const numPages = doc.numPages;

const pages = []; // { index (0-based), surname, given, base }
for (let i = 1; i <= numPages; i++) {
  const page = await doc.getPage(i);
  const text = (await page.getTextContent()).items
    .map((it) => it.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const surname = (text.match(/Surname\s+(.+?)\s+Given name/) || [])[1];
  const given = (text.match(/Given name\s+(.+?)\s+Sex/) || [])[1];
  if (!surname || !given) {
    console.warn(`⚠ page ${i}: could not read Surname/Given name — skipping`);
    continue;
  }
  pages.push({
    index: i - 1,
    surname: surname.trim(),
    given: given.trim(),
    base: toFilenameBase(surname, given),
  });
}

if (pages.length === 0) {
  console.error('No Form C pages with a readable name found. Nothing to do.');
  process.exit(1);
}

// ---- guard against two pages naming the same person -----------------------
// (e.g. a duplicate/draft page). Fail loudly so no output is silently overwritten.
const seen = new Map();
for (const p of pages) {
  if (seen.has(p.base)) {
    console.error(
      `✗ Two pages resolve to the same person "${p.base}": source pages ${seen.get(p.base) + 1} and ${p.index + 1}.\n` +
        `  Remove the duplicate page from ${path.basename(INPUT)} first (each person must appear once).`
    );
    process.exit(1);
  }
  seen.set(p.base, p.index);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- write one single-page PDF per person ---------------------------------

const srcBytes = fs.readFileSync(INPUT);
let written = 0;
for (const p of pages) {
  const src = await PDFDocument.load(srcBytes);
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(src, [p.index]);
  out.addPage(copied);

  const fileName = `${p.base}${OUT_SUFFIX}`;
  fs.writeFileSync(path.join(OUT_DIR, fileName), await out.save());
  written++;
  console.log(
    `✓ ${fileName}  (${p.surname} ${p.given}, source page ${p.index + 1})`
  );
}

console.log(`\nDone. Wrote ${written} Form C PDF(s) to:\n  ${OUT_DIR}`);
