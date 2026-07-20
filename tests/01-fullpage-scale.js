// tests/01-fullpage-scale.js
// Find the FASTEST scale that still reads all the C-form fields reliably.
// One tesseract call per scale; report time + whether key values appear.
// Run: node tests/01-fullpage-scale.js
import { fileURLToPath, URL } from 'node:url';
import {
  renderImage,
  ocrData,
  regionCanvas,
  upscale,
  box,
} from '../src/ocr-lib.js';

const BASE = fileURLToPath(new URL('../', import.meta.url)); // project root (scripts are in tests/)
const img = await renderImage(`${BASE}c-forms/EXAMPLE-PERSON-FORM-C.pdf`);
console.log(`image ${img.width}x${img.height}\n`);

const want = [
  'DOE',
  'JOHN',
  '01/01/1990',
  '00N0000001',
  '01/01/2020',
  '900A0000X',
  '01/01/2030',
];

for (const scale of [1, 1.5, 2]) {
  const s = process.hrtime.bigint();
  const words = ocrData(
    scale === 1
      ? regionCanvas(img, box(0, 0, 1, 1, { scale: 1 }))
      : upscale(regionCanvas(img, box(0, 0, 1, 1, { scale: 1 })), scale),
    { psm: 6 }
  );
  const ms = Number(process.hrtime.bigint() - s) / 1e6;
  const text = words.map((w) => w.text).join(' ');
  const found = want.filter((w) =>
    text.replace(/\s/g, '').includes(w.replace(/\s/g, ''))
  );
  console.log(
    `scale ${scale}: ${ms.toFixed(0)} ms, ${words.length} words, found ${found.length}/${want.length}: [${found.join(', ')}]`
  );
  const missing = want.filter((w) => !found.includes(w));
  if (missing.length) {
    console.log(`   missing: ${missing.join(', ')}`);
  }
}
