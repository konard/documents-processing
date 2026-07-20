// tests/04-debug-tsv-labels.js
// Inspect what the TSV pass actually detects, at a few scales, so we can see
// which labels are found and how legible the value cells are.
// Run: node tests/04-debug-tsv-labels.js
import { fileURLToPath, URL } from 'node:url';
import { renderImage, ocrData, createCanvas } from '../src/ocr-lib.js';

const BASE = fileURLToPath(new URL('../', import.meta.url)); // project root (scripts are in tests/)
const img = await renderImage(`${BASE}c-forms/EXAMPLE-PERSON-FORM-C.pdf`);
console.log(`image ${img.width}x${img.height}`);

const LABELS = [
  'surname',
  'given',
  'date',
  'birth',
  'passport',
  'no',
  'visa',
  'number',
  'nationality',
  'sex',
];

for (const scale of [0.75, 1.0, 1.5]) {
  const c = createCanvas(
    Math.round(img.width * scale),
    Math.round(img.height * scale)
  );
  c.getContext('2d').drawImage(img._canvas || img, 0, 0, c.width, c.height);
  const s = process.hrtime.bigint();
  const words = ocrData(c, { psm: 6 });
  const ms = Number(process.hrtime.bigint() - s) / 1e6;
  const found = words.filter((w) =>
    LABELS.includes(w.text.toLowerCase().replace(/[^a-z]/g, ''))
  );
  console.log(
    `\nscale ${scale} (${c.width}x${c.height}): ${ms.toFixed(0)}ms, ${words.length} words`
  );
  console.log(
    `  labels found: ${found
      .map((w) => `${w.text}@(${w.x},${w.y})`)
      .join('  ')}`
  );
}
