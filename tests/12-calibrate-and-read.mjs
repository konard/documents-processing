// tests/12-calibrate-and-read.js
// Combine every idea that worked:
//   1) CALIBRATE: search the crisp passports for the issue date; record the y
//      where valid reads appear; AVERAGE -> the expected date-row position.
//   2) READ with PERSPECTIVE SEARCH around that position: vary offset, scale,
//      rotation, and keepBlack threshold.
//   3) STRICT REGEX + SANITY filter: only count reads that are a real dd.mm.yyyy
//      with a valid day (01-31), month (01-12), plausible year (1980-2035).
//   4) PERCENTAGE consensus: winner must be a clear plurality (>=40% of valid
//      votes AND at least 2x the runner-up), not just "2 identical".
//
// Run: node tests/12-calibrate-and-read.js
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import {
  renderImage,
  box,
  regionCanvas,
  upscale,
  keepBlack,
  grayscale,
  dropChannel,
  contrast,
  ocrCanvas,
} from '../src/ocr-lib.mjs';

const BASE = fileURLToPath(new URL('../', import.meta.url)); // project root (scripts are in tests/)
const PP = `${BASE}passports-photos/`;
const TRUTH = {
  'DOE-JOHN': '01.01.2020',
  'ROE-JANE': '02.02.2021',
  'SMITH-ALEX': '03.03.2022',
  'JONES-MARY': '04.04.2023',
  'BROWN-SAM': '05.05.2024',
};

// find a valid date ANYWHERE in the text (tolerate surrounding specks), then
// sanity-check day/month/year — the sanity check is what filters the noise.
function parseValidDate(text) {
  const m = text.replace(/\s/g, '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) {
    return null;
  }
  const day = +m[1],
    month = +m[2],
    year = +m[3];
  if (
    day < 1 ||
    day > 31 ||
    month < 1 ||
    month > 12 ||
    year < 1980 ||
    year > 2035
  ) {
    return null;
  }
  return `${m[1]}.${m[2]}.${m[3]}`;
}

// one perspective read
function readAt(
  img,
  x,
  y,
  { w = 0.34, h = 0.024, scale = 4, threshold = 100, mode = 'keepBlack' }
) {
  let c = upscale(regionCanvas(img, box(x, y, w, h, { scale })), scale);
  if (mode === 'keepBlack') {
    c = keepBlack(c, threshold);
  } else if (mode === 'gray') {
    c = grayscale(c);
  } else if (mode === 'dropR') {
    c = keepBlack(dropChannel(c, 'r'), threshold);
  } else if (mode === 'contrast') {
    c = keepBlack(contrast(c, 0.5), threshold);
  }
  return parseValidDate(ocrCanvas(c, { whitelist: '0123456789.', psm: 7 }));
}

// STEP 1 — calibrate y on the crisp passports (those that read easily)
const CRISP = ['DOE-JOHN', 'ROE-JANE', 'SMITH-ALEX'];
const foundYs = [];
for (const name of CRISP) {
  const img = await renderImage(`${PP + name}-PASSPORT.jpg`);
  for (let y = 0.775; y <= 0.805; y += 0.002) {
    const v = readAt(img, 0.3, y, { threshold: 90 });
    if (v === TRUTH[name]) {
      foundYs.push(y);
      break;
    }
  }
}
const calibratedY = foundYs.length
  ? foundYs.reduce((a, b) => a + b) / foundYs.length
  : 0.789;
console.log(
  `calibrated date-row y = ${calibratedY.toFixed(4)} (from ${foundYs.length} crisp passports: ${foundYs.map((v) => v.toFixed(3)).join(', ')})\n`
);

// STEP 2+3+4 — read every passport with perspective search around calibratedY
let perfect = 0;
for (const file of fs
  .readdirSync(PP)
  .filter((f) => /\.jpe?g$/i.test(f))
  .sort()) {
  const name = file.replace(/-PASSPORT\.jpe?g$/i, '');
  const img = await renderImage(PP + file);
  const start = process.hrtime.bigint();
  const votes = new Map();
  let validReads = 0;
  // deep by nature: the perspective-search grid iterates offset × scale ×
  // threshold × mode; flattening it would obscure the tuning dimensions.
  /* eslint-disable max-depth */
  for (let dy = -0.012; dy <= 0.012; dy += 0.003) {
    for (const scale of [4, 5]) {
      for (const threshold of [80, 100, 120, 140, 160]) {
        for (const mode of ['keepBlack', 'dropR']) {
          const v = readAt(img, 0.3, calibratedY + dy, {
            scale,
            threshold,
            mode,
          });
          if (v) {
            votes.set(v, (votes.get(v) || 0) + 1);
            validReads++;
          }
        }
      }
    }
  }
  /* eslint-enable max-depth */
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [topValue, topCount] = ranked[0] || [null, 0];
  const runnerUp = ranked[1]?.[1] || 0;
  const share = validReads ? topCount / validReads : 0;
  // percentage consensus: clear plurality
  const accepted =
    topValue && share >= 0.4 && topCount >= runnerUp * 2 ? topValue : null;
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const ok = accepted === TRUTH[name];
  if (ok) {
    perfect++;
  }
  console.log(
    `${name.padEnd(26)} -> ${accepted || '(unread)'}  [${validReads} valid reads, top ${topCount} (${(share * 100).toFixed(0)}%), runnerUp ${runnerUp}, ${ms.toFixed(0)}ms] truth=${TRUTH[name]} ${ok ? '✅' : accepted ? '❌' : '⚠️'}`
  );
  if (!ok) {
    console.log(
      `   ranked: ${
        ranked
          .slice(0, 4)
          .map(([v, c]) => `${v}(${c})`)
          .join('  ') || '(no valid reads)'
      }`
    );
  }
}
console.log(`\n${perfect}/5 perfect.`);
