// tests/09-calibrate-search.js
// CALIBRATION step 1 (search): for a field, slide a window over an approximate
// area (a grid of x/y offsets, optionally small rotations) on EACH document and
// record every offset where OCR returns a valid-shaped value. The centroid of
// the hits is that document's field position; averaging across documents gives
// the calibrated "best spot".
//
// Here we calibrate the passport DATE OF ISSUE (dd.mm.yyyy), which lives on the
// red guilloche and needs precise placement.
//
// Run: node tests/09-calibrate-search.js
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import {
  renderImage,
  box,
  regionCanvas,
  upscale,
  grayscale,
  ocrCanvas,
} from '../src/ocr-lib.mjs';

const BASE = fileURLToPath(new URL('../', import.meta.url)); // project root (scripts are in tests/)
const PP = `${BASE}passports-photos/`;

// approximate search area for the issue date (fractions), plus the window size.
const SEARCH = {
  x0: 0.28,
  x1: 0.46,
  y0: 0.76,
  y1: 0.83,
  winW: 0.2,
  winH: 0.045,
};
const STEP = 0.01; // grid step in fractions
const isDate = (t) => /(\d{2})[.\s](\d{2})[.\s](\d{4})/.test(t);
const asDate = (t) => {
  const m = t.match(/(\d{2})[.\s](\d{2})[.\s](\d{4})/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
};

const results = {};
for (const file of fs
  .readdirSync(PP)
  .filter((f) => /\.jpe?g$/i.test(f))
  .sort()) {
  const name = file.replace(/-PASSPORT\.jpe?g$/i, '');
  const img = await renderImage(PP + file);
  const hits = []; // {x,y,value}
  for (let x = SEARCH.x0; x <= SEARCH.x1; x += STEP) {
    for (let y = SEARCH.y0; y <= SEARCH.y1; y += STEP) {
      const b = box(x, y, SEARCH.winW, SEARCH.winH, { scale: 4 });
      const canvas = grayscale(upscale(regionCanvas(img, b), 4));
      const text = ocrCanvas(canvas, { whitelist: '0123456789. ', psm: 7 });
      if (isDate(text)) {
        hits.push({ x: +x.toFixed(3), y: +y.toFixed(3), value: asDate(text) });
      }
    }
  }
  // centroid of hits + most common value
  const valueCounts = {};
  for (const h of hits) {
    valueCounts[h.value] = (valueCounts[h.value] || 0) + 1;
  }
  const best = Object.entries(valueCounts).sort((a, b) => b[1] - a[1])[0];
  const cx = hits.length
    ? hits.reduce((s, h) => s + h.x, 0) / hits.length
    : null;
  const cy = hits.length
    ? hits.reduce((s, h) => s + h.y, 0) / hits.length
    : null;
  results[name] = {
    hits: hits.length,
    centroid:
      cx !== null && cx !== undefined ? [+cx.toFixed(3), +cy.toFixed(3)] : null,
    value: best ? best[0] : null,
    agree: best ? best[1] : 0,
  };
  console.log(
    `${name.padEnd(26)} hits=${String(hits.length).padStart(2)} centroid=${results[name].centroid ? results[name].centroid.join(',') : '-'} value=${results[name].value || '(none)'} (${results[name].agree}x)`
  );
}

// average the centroids across documents that produced hits -> calibrated box x,y
const withHits = Object.values(results).filter((r) => r.centroid);
if (withHits.length) {
  const ax = withHits.reduce((s, r) => s + r.centroid[0], 0) / withHits.length;
  const ay = withHits.reduce((s, r) => s + r.centroid[1], 0) / withHits.length;
  console.log(
    `\ncalibrated issue-date box top-left ≈ x=${ax.toFixed(3)} y=${ay.toFixed(3)} (from ${withHits.length}/5 docs), win ${SEARCH.winW}x${SEARCH.winH}`
  );
}
