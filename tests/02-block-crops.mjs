// tests/02-block-crops.js
// RELIABLE + FAST approach: OCR a few single-column BLOCK crops per document
// (not full-page, not per-field). Measure time and field recall on all 4 C-forms.
// Run: node tests/02-block-crops.js
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import {
  renderImage,
  ocrData,
  regionCanvas,
  upscale,
  box,
} from '../src/ocr-lib.mjs';

const BASE = fileURLToPath(new URL('../', import.meta.url)); // project root (scripts are in tests/)
const FC = `${BASE}c-forms/`;

// Single-column value-region blocks (fractions). Kept generous for scan variance.
const BLOCKS = {
  personalValues: box(0.26, 0.34, 0.36, 0.13, { scale: 2 }), // surname, given, sex, dob, nationality
  passportBlock: box(0.1, 0.53, 0.55, 0.09, { scale: 2 }), // passport no, place, issue, expiry
  visaBlock: box(0.1, 0.63, 0.85, 0.07, { scale: 2 }), // visa no, valid till, issue, type
};

const files = fs
  .readdirSync(FC)
  .filter((f) => f.endsWith('-FORM-C.pdf'))
  .sort();
let totalMs = 0,
  calls = 0;
for (const f of files) {
  const img = await renderImage(FC + f);
  const s = process.hrtime.bigint();
  const texts = {};
  for (const [k, b] of Object.entries(BLOCKS)) {
    const words = ocrData(upscale(regionCanvas(img, b), b.scale), { psm: 6 });
    texts[k] = words.map((w) => w.text).join(' ');
    calls++;
  }
  const ms = Number(process.hrtime.bigint() - s) / 1e6;
  totalMs += ms;
  const all = Object.values(texts).join(' ').replace(/\s+/g, ' ');
  const dob = all.match(/\d{2}\/\d{2}\/\d{4}/g) || [];
  const visa = (all.match(/\b(VL\d{6,7}|901[A-Z0-9]{5,6})\b/) || [])[1];
  const pass = (all.match(/\b(\d{2}[A-Z]\d{6,7})\b/) || [])[1];
  console.log(
    `${f.replace('-FORM-C.pdf', '').padEnd(26)} ${ms.toFixed(0)}ms | pass=${pass || '?'} visa=${visa || '?'} dates=[${dob.join(' ')}]`
  );
}
console.log(
  `\n${calls} OCR calls total, ${totalMs.toFixed(0)}ms (${(totalMs / files.length).toFixed(0)}ms/doc, ${(totalMs / calls).toFixed(0)}ms/call)`
);
