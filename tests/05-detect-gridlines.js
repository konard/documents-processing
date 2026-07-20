// tests/05-detect-gridlines.js
// Detect the C-form's printed table rules by projecting dark pixels onto each
// axis: a horizontal rule = a row with many dark pixels across; a vertical rule
// = a column with many dark pixels down. Peaks in the projection = line
// positions. This gives exact cell rectangles, independent of OCR.
//
// Run: node tests/05-detect-gridlines.js
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

// return indices where projection exceeds `frac` of the max run length
function peaks(proj, frac, minGap) {
  const max = Math.max(...proj);
  const th = max * frac;
  const idx = [];
  for (let i = 0; i < proj.length; i++) {
    if (proj[i] >= th) {
      idx.push(i);
    }
  }
  // collapse runs of adjacent indices into a single line position (their center)
  const lines = [];
  let run = [];
  for (const i of idx) {
    if (run.length && i - run[run.length - 1] > minGap) {
      lines.push(Math.round(run.reduce((a, b) => a + b) / run.length));
      run = [];
    }
    run.push(i);
  }
  if (run.length) {
    lines.push(Math.round(run.reduce((a, b) => a + b) / run.length));
  }
  return lines;
}

const img = await renderImage(`${BASE}c-forms/EXAMPLE-PERSON-FORM-C.pdf`);
// work on a grayscale full page at modest scale
const g = grayscale(regionCanvas(img, box(0, 0, 1, 1, { scale: 1 })));
const W = g.width,
  H = g.height;
const d = g.getContext('2d').getImageData(0, 0, W, H).data;

// binary dark mask
const dark = new Uint8Array(W * H);
for (let i = 0, p = 0; i < d.length; i += 4, p++) {
  dark[p] = d[i] < 160 ? 1 : 0;
}

// horizontal projection (per row: count dark px) -> horizontal rules
const rowSum = new Array(H).fill(0);
for (let y = 0; y < H; y++) {
  let s = 0;
  for (let x = 0; x < W; x++) {
    s += dark[y * W + x];
  }
  rowSum[y] = s;
}
// vertical projection (per col) -> vertical rules
const colSum = new Array(W).fill(0);
for (let x = 0; x < W; x++) {
  let s = 0;
  for (let y = 0; y < H; y++) {
    s += dark[y * W + x];
  }
  colSum[x] = s;
}

const hLines = peaks(rowSum, 0.5, 5); // rules spanning >=50% width
const vLines = peaks(colSum, 0.5, 5);
console.log(`image ${W}x${H}`);
console.log(`horizontal rules (${hLines.length}): ${hLines.join(', ')}`);
console.log(`vertical rules   (${vLines.length}): ${vLines.join(', ')}`);

// visualize: draw detected lines over the page
const vis = createCanvas(W, H);
const vctx = vis.getContext('2d');
vctx.drawImage(g, 0, 0);
vctx.strokeStyle = 'red';
vctx.lineWidth = 2;
for (const y of hLines) {
  vctx.beginPath();
  vctx.moveTo(0, y);
  vctx.lineTo(W, y);
  vctx.stroke();
}
vctx.strokeStyle = 'blue';
for (const x of vLines) {
  vctx.beginPath();
  vctx.moveTo(x, 0);
  vctx.lineTo(x, H);
  vctx.stroke();
}
save(vis, `${OUT}gridlines-EXAMPLE.png`);
console.log(`\nwrote ${OUT}gridlines-EXAMPLE.png`);
