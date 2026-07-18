#!/usr/bin/env node
// jpg-to-pdf.js
//
// Converts every JPG (and PNG) image in a folder into a full-page PDF with the
// same basename, so you get matching  <NAME>.jpg  +  <NAME>.pdf  pairs.
//
// Each PDF has a single page sized exactly to the image, so the picture fills
// the whole page with no borders or scaling artifacts.
//
// Usage:  node jpg-to-pdf.js [dir]
//         (defaults to the ./passports-photos folder next to this script)
//
// Requires: pdf-lib  (npm dependency).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config ---------------------------------------------------------------

// Scripts live in src/; the passports-photos/ folder lives one level up in the project root.
const DIR =
  process.argv[2] || path.join(path.dirname(__dirname), 'passports-photos');
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);

// ---- convert each image ---------------------------------------------------

const files = fs
  .readdirSync(DIR)
  .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
  .sort();

if (files.length === 0) {
  console.error(`No JPG/PNG images found in ${DIR}. Nothing to do.`);
  process.exit(1);
}

let count = 0;
for (const f of files) {
  const ext = path.extname(f).toLowerCase();
  const base = f.slice(0, -ext.length);
  const imgPath = path.join(DIR, f);
  const pdfPath = path.join(DIR, `${base}.pdf`);

  const imgBytes = fs.readFileSync(imgPath);
  const pdf = await PDFDocument.create();
  const img =
    ext === '.png'
      ? await pdf.embedPng(imgBytes)
      : await pdf.embedJpg(imgBytes);

  // Page is exactly the image's pixel dimensions -> the image fills the page.
  const page = pdf.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });

  fs.writeFileSync(pdfPath, await pdf.save());
  count++;
  console.log(`✓ ${f}  ->  ${base}.pdf  (${img.width}×${img.height})`);
}

console.log(`\nDone. Converted ${count} image(s) to PDF in:\n  ${DIR}`);
