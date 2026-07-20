// tests/06-faint-line-detection.js
// EXPERIMENT (kept for future): detect the FAINT gray table rules, not the
// dark text. Idea: a table rule is a LONG THIN run of mid-gray pixels. We
// threshold for mid-gray (not black text, not white bg), then require a run to
// span most of the width/height to count as a rule. Text fails the "long thin
// continuous run" test, so this should separate rules from text.
//
// Status: partial — documents the approach; borders here are very light so
// recall is imperfect. Kept as a starting point for a better cell detector.
//
// Run: node tests/06-faint-line-detection.js
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import {
  renderImage,
  grayscale,
  regionCanvas,
  box,
  save,
  createCanvas,
} from '../src/ocr-lib.js';

const BASE = fileURLToPath(new URL('../', import.meta.url)); // project root (scripts are in tests/)
const OUT = fileURLToPath(new URL('out/', import.meta.url));
fs.mkdirSync(OUT, { recursive: true });

const img = await renderImage(`${BASE}c-forms/EXAMPLE-PERSON-FORM-C.pdf`);
const g = grayscale(regionCanvas(img, box(0, 0, 1, 1, { scale: 1 })));
const W = g.width,
  H = g.height;
const d = g.getContext('2d').getImageData(0, 0, W, H).data;
const gray = (x, y) => d[(y * W + x) * 4];

// A "line" pixel: darker than white bg but part of a long run. First mark any
// pixel that is <200 (not pure white). Then find rows/cols whose longest
// CONTINUOUS run of such pixels covers >=60% of the span (a rule), which text
// (short runs with gaps) won't satisfy.
function longestRun(isOn, n) {
  let best = 0,
    cur = 0;
  for (let i = 0; i < n; i++) {
    if (isOn(i)) {
      cur++;
      best = Math.max(best, cur);
    } else {
      cur = 0;
    }
  }
  return best;
}

const hRules = [];
for (let y = 0; y < H; y++) {
  const run = longestRun((x) => gray(x, y) < 205, W);
  if (run >= W * 0.6) {
    hRules.push(y);
  }
}
const vRules = [];
for (let x = 0; x < W; x++) {
  const run = longestRun((y) => gray(x, y) < 205, H);
  if (run >= H * 0.55) {
    vRules.push(x);
  }
}

// collapse adjacent
const collapse = (arr, gap) => {
  const out = [];
  let run = [];
  for (const i of arr) {
    if (run.length && i - run[run.length - 1] > gap) {
      out.push(Math.round(run.reduce((a, b) => a + b) / run.length));
      run = [];
    }
    run.push(i);
  }
  if (run.length) {
    out.push(Math.round(run.reduce((a, b) => a + b) / run.length));
  }
  return out;
};
const H2 = collapse(hRules, 6),
  V2 = collapse(vRules, 6);
console.log(
  `faint horizontal rules (${H2.length}): ${H2.slice(0, 40).join(', ')}`
);
console.log(
  `faint vertical rules   (${V2.length}): ${V2.slice(0, 40).join(', ')}`
);

const vis = createCanvas(W, H);
const c = vis.getContext('2d');
c.drawImage(g, 0, 0);
c.strokeStyle = 'red';
c.lineWidth = 2;
for (const y of H2) {
  c.beginPath();
  c.moveTo(0, y);
  c.lineTo(W, y);
  c.stroke();
}
c.strokeStyle = 'blue';
for (const x of V2) {
  c.beginPath();
  c.moveTo(x, 0);
  c.lineTo(x, H);
  c.stroke();
}
save(vis, `${OUT}faintlines-EXAMPLE.png`);
console.log(`wrote ${OUT}faintlines-EXAMPLE.png`);
