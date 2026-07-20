// tests/03-label-anchored-cells.js
// Per-FIELD but FAST + RELIABLE:
//   1) one cheap TSV pass over a downscaled page -> find each LABEL word's box
//   2) for each field, crop the VALUE cell to the RIGHT of its label, at the
//      label's row-y, and OCR just that one cell (single call per field).
// The label anchors self-calibrate per document, so ±scan variance doesn't drift.
//
// Run: node tests/03-label-anchored-cells.js
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import {
  renderImage,
  ocrData,
  ocrCanvas,
  regionCanvas,
  upscale,
  box,
  createCanvas,
} from '../src/ocr-lib.js';

const BASE = fileURLToPath(new URL('../', import.meta.url)); // project root (scripts are in tests/)
const FC = `${BASE}c-forms/`;

// Labels we want, and the regex/whitelist for their value.
const FIELDS = [
  { key: 'surname', label: /^surname$/i, wl: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ-' },
  { key: 'given', label: /^given$/i, wl: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ- ' },
  { key: 'dob', label: /^date$/i, near: /birth/i, wl: '0123456789/' },
  {
    key: 'passportNo',
    label: /^passport$/i,
    near: /^no/i,
    wl: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  },
  {
    key: 'visaNumber',
    label: /^visa$/i,
    near: /number/i,
    wl: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  },
];

// find a label word (optionally requiring a neighbor word matching `near`)
function findLabel(words, f) {
  for (let i = 0; i < words.length; i++) {
    if (!f.label.test(words[i].text)) {
      continue;
    }
    if (f.near) {
      const nbr = words.slice(i + 1, i + 3).some((w) => f.near.test(w.text));
      if (!nbr) {
        continue;
      }
    }
    return words[i];
  }
  return null;
}

const files = fs
  .readdirSync(FC)
  .filter((f) => f.endsWith('-FORM-C.pdf'))
  .sort();
let totalMs = 0,
  totalCalls = 0;

for (const f of files) {
  const img = await renderImage(FC + f);
  const s = process.hrtime.bigint();

  // (1) locate labels: one TSV pass at 0.75 scale (fastest AND most labels found)
  const LS = 0.75;
  const small = createCanvas(
    Math.round(img.width * LS),
    Math.round(img.height * LS)
  );
  small
    .getContext('2d')
    .drawImage(img._canvas || img, 0, 0, small.width, small.height);
  const words = ocrData(small, { psm: 6 });
  let calls = 1;

  const out = {};
  for (const fld of FIELDS) {
    const lab = findLabel(words, fld);
    if (!lab) {
      out[fld.key] = null;
      continue;
    }
    // Value cell sits to the RIGHT of the label, on the same row. Convert the
    // label box (in small-scale px) to full-res fractions, then place the value
    // window from just past the label to the value-column's right edge (~0.63).
    const labRightFrac = (lab.x + lab.w) / small.width;
    const labYFrac = lab.y / small.height,
      labHFrac = lab.h / small.height;
    const b = box(
      labRightFrac + 0.01,
      labYFrac - labHFrac * 0.4,
      Math.max(0.1, 0.63 - (labRightFrac + 0.01)),
      labHFrac * 1.8,
      { scale: 3 }
    );
    const val = ocrCanvas(upscale(regionCanvas(img, b), 3), {
      psm: 7,
      whitelist: fld.wl,
    }).trim();
    out[fld.key] = val || null;
    calls++;
  }
  const ms = Number(process.hrtime.bigint() - s) / 1e6;
  totalMs += ms;
  totalCalls += calls;
  console.log(
    `${f.replace('-FORM-C.pdf', '').padEnd(26)} ${ms.toFixed(0)}ms/${calls}calls | surname=${out.surname} given=${out.given} dob=${out.dob} pass=${out.passportNo} visa=${out.visaNumber}`
  );
}
console.log(
  `\navg ${(totalMs / files.length).toFixed(0)}ms/doc, ${(totalMs / totalCalls).toFixed(0)}ms/call`
);
