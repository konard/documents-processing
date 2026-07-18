// tests/00-speed-baseline.js
// Measure the cost of the two OCR strategies so we pick the FAST one:
//   (A) one full-page TSV OCR per document  (target: fast, reliable)
//   (B) per-field consensus (offsets x preprocess) — the slow trap to avoid
//
// Run:  node tests/00-speed-baseline.js
import { fileURLToPath, URL } from 'node:url';
import {
  renderImage,
  ocrData,
  regionCanvas,
  upscale,
  box,
  readFieldConsensus,
} from '../ocr-lib.js';

const BASE = fileURLToPath(new URL('../../', import.meta.url)); // project root (scripts are in src/tests/)
const cform = `${BASE}c-forms/EXAMPLE-PERSON-FORM-C.pdf`;

const ta = async (label, fn) => {
  const s = process.hrtime.bigint();
  const r = await fn();
  const ms = Number(process.hrtime.bigint() - s) / 1e6;
  console.log(`${label}: ${ms.toFixed(0)} ms`);
  return r;
};

const img = await ta('render (extract embedded image)', () =>
  renderImage(cform)
);
console.log(`  image ${img.width}x${img.height}`);

// (A) ONE full-page TSV pass
const words = await ta('A) full-page ocrData (1 tesseract call)', () =>
  Promise.resolve(
    ocrData(upscale(regionCanvas(img, box(0, 0, 1, 1, { scale: 1 })), 2), {
      psm: 6,
    })
  )
);
console.log(`  -> ${words.length} words`);

// (B) consensus on ONE field (4 offsets x 3 preprocess = 12 tesseract calls)
await ta('B) readFieldConsensus for ONE field (12 calls)', () =>
  Promise.resolve(
    readFieldConsensus(img, box(0.27, 0.4, 0.34, 0.03), { psm: 7 })
  )
);

console.log('\nTakeaway: multiply B) by ~15 fields x 19 docs to see the trap.');
