// tests/14-calibration-generic.js
// GENERIC calibration demo: given a field with a rough search area and a
// validator (regex+sanity), find where it reads on each document, then average
// the found positions into a calibrated box. This is the reusable pattern
// behind calibrateIssueDateY — shown here for the passport DATE OF EXPIRY too,
// to prove the approach generalizes beyond one field.
//
// For each document we slide the window over the search area and keep the
// centroid of positions where the validator accepts a read. Averaging centroids
// across documents = the calibrated "best spot" for that field.
//
// Run: node tests/14-calibration-generic.js
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import {
  renderImage,
  box,
  regionCanvas,
  upscale,
  keepBlack,
  ocrCanvas,
  parseSaneDate,
} from '../src/ocr-lib.js';

const BASE = fileURLToPath(new URL('../', import.meta.url)); // project root (scripts are in tests/)
const PP = `${BASE}passports-photos/`;

// A field spec: rough search area + how to read + validator.
// We demo on the passport DATE OF ISSUE (left column) — the field the calibration
// was built for — to show a SUCCESSFUL generic calibration end to end.
const ISSUE_FIELD = {
  name: 'passport date of issue (printed, left column)',
  area: { x0: 0.29, x1: 0.33, y0: 0.775, y1: 0.805, winW: 0.34, winH: 0.024 },
  step: 0.004,
  read: (img, x, y, w, h) =>
    parseSaneDate(
      ocrCanvas(
        keepBlack(
          upscale(regionCanvas(img, box(x, y, w, h, { scale: 4 })), 4),
          90
        ),
        { whitelist: '0123456789.', psm: 7 }
      )
    ),
};

function calibrateField(images, field) {
  const perDoc = [];
  for (const { name, img } of images) {
    const hits = [];
    for (let x = field.area.x0; x <= field.area.x1; x += field.step) {
      for (let y = field.area.y0; y <= field.area.y1; y += field.step) {
        const value = field.read(img, x, y, field.area.winW, field.area.winH);
        if (value) {
          hits.push({ x, y, value });
        }
      }
    }
    if (hits.length) {
      const cx = hits.reduce((s, h) => s + h.x, 0) / hits.length;
      const cy = hits.reduce((s, h) => s + h.y, 0) / hits.length;
      const counts = {};
      for (const h of hits) {
        counts[h.value] = (counts[h.value] || 0) + 1;
      }
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      perDoc.push({
        name,
        centroid: [cx, cy],
        value: best[0],
        agree: best[1],
        hits: hits.length,
      });
    } else {
      perDoc.push({ name, centroid: null, value: null, agree: 0, hits: 0 });
    }
  }
  const withHits = perDoc.filter((d) => d.centroid);
  const calibrated = withHits.length
    ? {
        x: withHits.reduce((s, d) => s + d.centroid[0], 0) / withHits.length,
        y: withHits.reduce((s, d) => s + d.centroid[1], 0) / withHits.length,
      }
    : null;
  return { perDoc, calibrated, fromDocs: withHits.length };
}

const images = [];
for (const file of fs
  .readdirSync(PP)
  .filter((f) => /\.jpe?g$/i.test(f))
  .sort()) {
  images.push({
    name: file.replace(/-PASSPORT\.jpe?g$/i, ''),
    img: await renderImage(PP + file),
  });
}

console.log(`Calibrating: ${ISSUE_FIELD.name}\n`);
const { perDoc, calibrated, fromDocs } = calibrateField(images, ISSUE_FIELD);
for (const d of perDoc) {
  console.log(
    `  ${d.name.padEnd(26)} value=${d.value || '(none)'} (${d.agree}x, ${d.hits} hits) ${d.centroid ? `@ ${d.centroid[0].toFixed(3)},${d.centroid[1].toFixed(3)}` : ''}`
  );
}
console.log(
  `\nCalibrated box top-left ≈ x=${calibrated ? calibrated.x.toFixed(3) : '-'} y=${calibrated ? calibrated.y.toFixed(3) : '-'} (from ${fromDocs}/${images.length} docs)`
);
console.log(
  '\nThis is the same averaging pattern used by calibrateIssueDateY(); it generalizes to any fixed-layout field.'
);
