#!/usr/bin/env node
// join-letter-attachments.mjs
//
// Builds a single PDF that is the explanation letter followed by its attachment
// documents:
//   - page 1..     = the letter, rendered fresh from its Markdown source
//   - then         = every attachment PDF, in the order given
//
// The letter is (re)rendered from Markdown via markdown-to-pdf.mjs, so editing
// the Markdown and re-running this script is all that's needed to update both
// the standalone letter PDF and this combined file.
//
// Usage:
//   node join-letter-attachments.mjs <letter.md> <output.pdf> <attachment1.pdf> [attachment2.pdf ...]
//
// Requires: pdf-lib  (npm dependency).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- args -----------------------------------------------------------------

const [letterMd, outputPdf, ...attachments] = process.argv.slice(2);
if (!letterMd || !outputPdf || attachments.length === 0) {
  console.error(
    'Usage: node join-letter-attachments.mjs <letter.md> <output.pdf> <attachment1.pdf> [attachment2.pdf ...]'
  );
  process.exit(1);
}

// ---- 1) render the letter Markdown to a temporary PDF ---------------------

// --fit-one-page: keep each explanation letter to a single page (shrinking the
// typography a little if needed) so it does not spill onto page 2.
const letterPdf = `${letterMd.replace(/\.md$/i, '')}.pdf`;
execFileSync(
  'node',
  [
    path.join(__dirname, 'markdown-to-pdf.mjs'),
    letterMd,
    letterPdf,
    '--fit-one-page',
  ],
  { stdio: 'inherit' }
);

// ---- 2) concatenate: letter, then each attachment -------------------------

const out = await PDFDocument.create();

async function appendPdf(file, label) {
  if (!fs.existsSync(file)) {
    console.warn(`⚠ attachment not found, skipped: ${file}`);
    return 0;
  }
  const doc = await PDFDocument.load(fs.readFileSync(file));
  const pages = await out.copyPages(doc, doc.getPageIndices());
  pages.forEach((p) => out.addPage(p));
  console.log(`  + ${label}: ${doc.getPageCount()} page(s)`);
  return doc.getPageCount();
}

console.log('Building combined PDF:');
await appendPdf(letterPdf, path.basename(letterPdf));
for (const attachment of attachments) {
  await appendPdf(attachment, path.basename(attachment));
}

fs.mkdirSync(path.dirname(outputPdf), { recursive: true });
// useObjectStreams:false → classic xref table, maximally compatible with
// stricter PDF parsers (e.g. eFRRO), which can reject ObjStm-based PDFs.
fs.writeFileSync(outputPdf, await out.save({ useObjectStreams: false }));
console.log(`\n✓ Wrote ${outputPdf}  (${out.getPageCount()} pages total)`);
