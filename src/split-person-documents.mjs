#!/usr/bin/env node
// split-person-documents.mjs
//
// For every person folder under documents-by-person/, derive the upload-ready
// per-document PDFs from that person's combined PASSPORT-AND-INDIA-VISA.pdf:
//
//   3-page source [passport(scan), entry-stamp(scan), e-visa(TEXT)]:
//     PASSPORT-COMPRESSED.pdf       <- page 1, image recompressed (≤1280 px)
//     ENTRY-STAMP-COMPRESSED.pdf    <- page 2, image recompressed (≤1280 px)
//     E-VISA.pdf                    <- page 3, COPIED VERBATIM (text + emblem
//                                      transparency must never be recompressed)
//
//   2-page source [passport(scan), india-visa(scan)]:
//     PASSPORT-COMPRESSED.pdf       <- page 1, image recompressed (≤1280 px)
//     INDIA-VISA-COMPRESSED.pdf     <- page 2, image recompressed (≤1280 px)
//
//   plus, for everyone:
//     PASSPORT-AND-INDIA-VISA-COMPRESSED.pdf  <- the whole combined doc,
//                                      compressed (e-visa page left verbatim by
//                                      compress-pdf, which only swaps raster).
//
// Pages are routed by source page count: a 3-page source is
// [passport, entry-stamp, e-visa], so its e-visa page (page 3) is copied
// verbatim while the two scans are recompressed; a 2-page source is two scans,
// both recompressed. Copying the e-visa verbatim keeps its emblem transparency
// and selectable text intact.
//
// Recompression is delegated to compress-pdf.mjs (resolution cap 1280 px,
// baseline JPEG, classic xref) so there is ONE compression implementation.
//
// Usage:  node split-person-documents.mjs [baseDir]
//
// Requires: pdf-lib.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Scripts live in src/; document folders live one level up in the project root.
const BASE = process.argv[2] || path.dirname(__dirname);
const PERSON_ROOT = path.join(BASE, 'documents-by-person');
const SOURCE_NAME = 'PASSPORT-AND-INDIA-VISA.pdf';

// Write a single page of `sourceDoc` to its own one-page PDF (classic xref).
async function writeSinglePage(sourceBytes, pageIndex, outputPath) {
  const sourceDoc = await PDFDocument.load(sourceBytes);
  const outDoc = await PDFDocument.create();
  const [page] = await outDoc.copyPages(sourceDoc, [pageIndex]);
  outDoc.addPage(page);
  fs.writeFileSync(outputPath, await outDoc.save({ useObjectStreams: false }));
}

// Recompress a scan page in place via the single compress-pdf implementation.
function compress(inputPath, outputPath) {
  execFileSync(
    'node',
    [path.join(__dirname, 'compress-pdf.mjs'), inputPath, outputPath],
    { stdio: 'inherit' }
  );
}

const people = fs.existsSync(PERSON_ROOT)
  ? fs
      .readdirSync(PERSON_ROOT)
      .filter((name) => fs.statSync(path.join(PERSON_ROOT, name)).isDirectory())
      .sort()
  : [];

for (const person of people) {
  const personDir = path.join(PERSON_ROOT, person);
  const sourcePath = path.join(personDir, SOURCE_NAME);
  if (!fs.existsSync(sourcePath)) {
    console.warn(`⚠ ${person}: no ${SOURCE_NAME}, skipped`);
    continue;
  }

  const sourceBytes = new Uint8Array(fs.readFileSync(sourcePath));
  const sourceDoc = await PDFDocument.load(sourceBytes);
  const pageCount = sourceDoc.getPageCount();

  // Page 1 is always the passport scan.
  const tempDir = fs.mkdtempSync(path.join(personDir, '.split-'));
  const built = [];
  try {
    const passportTemp = path.join(tempDir, 'passport.pdf');
    await writeSinglePage(sourceBytes, 0, passportTemp);
    compress(passportTemp, path.join(personDir, 'PASSPORT-COMPRESSED.pdf'));
    built.push('PASSPORT-COMPRESSED.pdf');

    if (pageCount === 3) {
      // [passport, entry-stamp, e-visa] — e-visa (page 3) copied verbatim.
      const entryTemp = path.join(tempDir, 'entry.pdf');
      await writeSinglePage(sourceBytes, 1, entryTemp);
      compress(entryTemp, path.join(personDir, 'ENTRY-STAMP-COMPRESSED.pdf'));
      built.push('ENTRY-STAMP-COMPRESSED.pdf');

      await writeSinglePage(sourceBytes, 2, path.join(personDir, 'E-VISA.pdf')); // verbatim, no compression
      built.push('E-VISA.pdf (verbatim)');
    } else if (pageCount === 2) {
      // [passport, india-visa] — the VL visa is a scan.
      const visaTemp = path.join(tempDir, 'visa.pdf');
      await writeSinglePage(sourceBytes, 1, visaTemp);
      compress(visaTemp, path.join(personDir, 'INDIA-VISA-COMPRESSED.pdf'));
      built.push('INDIA-VISA-COMPRESSED.pdf');
    } else {
      console.warn(`⚠ ${person}: unexpected page count ${pageCount}`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  // Combined compressed (e-visa text page is left verbatim by compress-pdf).
  compress(
    sourcePath,
    path.join(personDir, 'PASSPORT-AND-INDIA-VISA-COMPRESSED.pdf')
  );
  built.push('PASSPORT-AND-INDIA-VISA-COMPRESSED.pdf');

  console.log(`✓ ${person}: ${built.join(', ')}`);
}

console.log('\nDone. Per-person documents split & compressed.');
