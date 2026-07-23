#!/usr/bin/env node
// join-passport-visa.mjs
//
// For each passenger, combines their passport, India e-Visa entry-stamp page
// (if any), and India visa into a single PDF:
//   - page 1 = passport        (first page of passports-documents/<NAME>-PASSPORT.pdf)
//   - page 2 = passport entry   (passport-entries/<NAME>-PASSPORT-ENTRY.pdf)  [ONLY if it exists]
//   - last   = visa             (first page of india-visas/<NAME>-INDIA-VISA.pdf)
//
// People with an ETA (e-Visa) have a scanned entry-stamp page, so their
// document ends up 3 pages. People with a regular VL sticker visa have no
// separate entry page, so theirs is 2 pages (passport + visa).
//
// SIZE NORMALIZATION (done here, in the original — NOT compression):
// scanned pages (the entry-stamp page, a VL visa sticker) often come at a much
// higher pixel/page size than the passport page, which makes pages "jump" in
// size when flipping through. So any scan page larger than the passport is
// resized DOWN to the passport's pixel size, keeping its ORIGINAL encoding:
//   - a lossless (Flate/PNG) scan is resized losslessly and re-stored as PNG,
//   - a JPEG (DCTDecode) scan is resized and re-encoded as JPEG at 99% quality.
// The passport page and any text/vector pages (an e-visa/ETA) are copied verbatim.
//
// Pairs are matched by the shared <NAME> prefix. Output goes to
//   passports-and-visas/<NAME>-PASSPORT-AND-VISA.pdf
//
// Usage:  node join-passport-visa.mjs [baseDir]
//
// Requires: pdf-lib, pdfjs-dist, sharp, pako  (npm dependencies).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractBiggestImage, fitLongest } from './pdf-image-tools.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config ---------------------------------------------------------------

// Scripts live in src/; document folders live one level up in the project root.
const BASE = process.argv[2] || path.dirname(__dirname);
const PASSPORT_DIR = path.join(BASE, 'passports-documents');
const ENTRY_DIR = path.join(BASE, 'passport-entries');
const VISA_DIR = path.join(BASE, 'india-visas');
const OUT_DIR = path.join(BASE, 'passports-and-visas');

const PASSPORT_SUFFIX = '-PASSPORT.pdf';
const ENTRY_SUFFIX = '-PASSPORT-ENTRY.pdf';
const VISA_SUFFIX = '-INDIA-VISA.pdf';
const OUT_SUFFIX = '-PASSPORT-AND-VISA.pdf';

// ---- pair passports with visas by shared name prefix ----------------------

const passports = new Map(); // NAME -> filename
const visas = new Map(); // NAME -> filename
const entries = new Map(); // NAME -> filename (optional)

for (const f of fs.readdirSync(PASSPORT_DIR)) {
  if (f.endsWith(PASSPORT_SUFFIX)) {
    passports.set(f.slice(0, -PASSPORT_SUFFIX.length), f);
  }
}
for (const f of fs.readdirSync(VISA_DIR)) {
  if (f.endsWith(VISA_SUFFIX)) {
    visas.set(f.slice(0, -VISA_SUFFIX.length), f);
  }
}
if (fs.existsSync(ENTRY_DIR)) {
  for (const f of fs.readdirSync(ENTRY_DIR)) {
    if (f.endsWith(ENTRY_SUFFIX)) {
      entries.set(f.slice(0, -ENTRY_SUFFIX.length), f);
    }
  }
}

const names = [...passports.keys()].filter((n) => visas.has(n)).sort();

// Warn about anything unpaired so nothing is silently skipped.
for (const n of passports.keys()) {
  if (!visas.has(n)) {
    console.warn(`⚠ passport without visa: ${passports.get(n)}`);
  }
}
for (const n of visas.keys()) {
  if (!passports.has(n)) {
    console.warn(`⚠ visa without passport: ${visas.get(n)}`);
  }
}

if (names.length === 0) {
  console.error('No matching PASSPORT + VISA pairs found. Nothing to do.');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- image helpers (extract / resize preserving encoding, via sharp) ------

// Add `pdfBytes`'s page, resized DOWN so it is no bigger than the passport
// (in pixels and on-page width), PRESERVING the source encoding:
//   JPEG source     → JPEG at 95% (visually lossless, keeps photo compact)
//   lossless source → PNG (lossless, no artifacts — as the original was)
// Returns true if it normalized, false if it just copied the page verbatim.
async function addNormalizedScanPage(outputDocument, pdfBytes, passport) {
  const image = await extractBiggestImage(pdfBytes);
  if (!image) {
    // no raster we can normalize — copy the page verbatim
    const sourceDocument = await PDFDocument.load(pdfBytes);
    const [copiedPage] = await outputDocument.copyPages(sourceDocument, [0]);
    outputDocument.addPage(copiedPage);
    return false;
  }
  const pipeline = fitLongest(
    image.sharp(),
    image.width,
    image.height,
    passport.imageLongestPixels
  );
  let embedded;
  if (image.isJpeg) {
    // BASELINE JPEG (progressive:false, and NOT mozjpeg — mozjpeg forces
    // progressive). Progressive JPEGs can break PDF viewers / server parsers
    // that only support baseline DCTDecode.
    const jpegBuffer = await pipeline
      .jpeg({ quality: 95, progressive: false })
      .toBuffer();
    embedded = await outputDocument.embedJpg(jpegBuffer); // JPEG source → JPEG 95%
  } else {
    const pngBuffer = await pipeline.png().toBuffer(); // lossless source → PNG (no artifacts)
    embedded = await outputDocument.embedPng(pngBuffer);
  }
  const aspectRatio = embedded.height / embedded.width;
  const pageWidth = passport.pageWidth;
  const pageHeight = passport.pageWidth * aspectRatio;
  const page = outputDocument.addPage([pageWidth, pageHeight]);
  page.drawImage(embedded, {
    x: 0,
    y: 0,
    width: pageWidth,
    height: pageHeight,
  });
  return true;
}

// ---- build the combined PDFs ----------------------------------------------

// Is the first page essentially an image-only scan (so it's safe to normalize
// its raster) and not a text/vector page (an e-visa/ETA we must keep as text)?
async function isImageOnlyScan(pdfBytes) {
  const document = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) })
    .promise;
  const page = await document.getPage(1);
  const textContent = (await page.getTextContent()).items
    .map((item) => item.str)
    .join('')
    .replace(/\s+/g, '');
  return textContent.length < 40;
}

for (const personName of names) {
  const outputDocument = await PDFDocument.create();
  const pageLabels = [];

  // Page 1: passport (first page) — the REFERENCE size. Copied verbatim.
  const passportBytes = fs.readFileSync(
    path.join(PASSPORT_DIR, passports.get(personName))
  );
  const passportDocument = await PDFDocument.load(passportBytes);
  const [passportPage] = await outputDocument.copyPages(passportDocument, [0]);
  outputDocument.addPage(passportPage);
  pageLabels.push('passport');

  // Reference geometry from the passport: its on-page width and its image's
  // longest pixel side. Every larger scan is brought down to this.
  const passportImage = await extractBiggestImage(passportBytes);
  const passport = {
    pageWidth: passportPage.getWidth(),
    imageLongestPixels: passportImage
      ? Math.max(passportImage.width, passportImage.height)
      : Math.max(passportPage.getWidth(), passportPage.getHeight()),
  };

  // Page 2 (optional): passport entry stamp — a scan; normalize it to the passport.
  if (entries.has(personName)) {
    const entryBytes = fs.readFileSync(
      path.join(ENTRY_DIR, entries.get(personName))
    );
    const wasNormalized = await addNormalizedScanPage(
      outputDocument,
      entryBytes,
      passport
    );
    pageLabels.push(wasNormalized ? 'entry(normalized)' : 'entry');
  }

  // Last page: visa. A VL sticker is a scan → normalize; an ETA/e-visa is
  // text → copy verbatim (never rasterized).
  const visaBytes = fs.readFileSync(path.join(VISA_DIR, visas.get(personName)));
  if (await isImageOnlyScan(visaBytes)) {
    const wasNormalized = await addNormalizedScanPage(
      outputDocument,
      visaBytes,
      passport
    );
    pageLabels.push(wasNormalized ? 'visa(normalized)' : 'visa');
  } else {
    const visaDocument = await PDFDocument.load(visaBytes);
    const [visaPage] = await outputDocument.copyPages(visaDocument, [0]);
    outputDocument.addPage(visaPage);
    pageLabels.push('visa(text)');
  }

  const outputName = `${personName}${OUT_SUFFIX}`;
  // useObjectStreams:false → classic PDF with a plain xref table (no ObjStm),
  // the most universally compatible layout; stricter parsers (e.g. eFRRO) can
  // fail to open PDFs that use compressed object streams.
  fs.writeFileSync(
    path.join(OUT_DIR, outputName),
    await outputDocument.save({ useObjectStreams: false })
  );
  console.log(
    `✓ ${outputName}  (${pageLabels.join(' + ')} = ${outputDocument.getPageCount()} pages)`
  );
}

console.log(`\nDone. Wrote ${names.length} combined PDF(s) to:\n  ${OUT_DIR}`);
