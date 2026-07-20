// tests/11-issue-date-search-consensus.js
// Combine SEARCH (find the date row per document) with CONSENSUS (agree on the
// digits). For each passport: slide the tight box over a y-range, keepBlack, OCR;
// collect every valid dd.mm.yyyy read across y-offsets AND black-thresholds;
// the value with the most agreement wins. This adapts to each scan's framing.
//
// Run: node tests/11-issue-date-search-consensus.js
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import {
  renderImage,
  box,
  regionCanvas,
  upscale,
  keepBlack,
  ocrCanvas,
} from '../src/ocr-lib.js';

const BASE = fileURLToPath(new URL('../', import.meta.url)); // project root (scripts are in tests/)
const PP = `${BASE}passports-photos/`;
// Corrected truths (re-read from the scans this session).
const TRUTH = {
  'DOE-JOHN': '01.01.2020',
  'ROE-JANE': '02.02.2021',
  'SMITH-ALEX': '03.03.2022',
  'JONES-MARY': '04.04.2023',
  'BROWN-SAM': '05.05.2024',
};
const onlyDate = (t) => {
  const m = t.replace(/ /g, '').match(/(\d{2})\.?(\d{2})\.?(\d{4})/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : '';
};

function readIssueDate(img) {
  const votes = new Map();
  // search a WIDER y-range (scans are framed differently) and more thresholds
  // (fainter/older passports need a higher black cutoff to catch mid-tone ink).
  for (let y = 0.765; y <= 0.815; y += 0.003) {
    for (const threshold of [70, 85, 100, 115, 130, 145]) {
      const region = upscale(
        regionCanvas(img, box(0.29, y, 0.36, 0.024, { scale: 4 })),
        4
      );
      const value = onlyDate(
        ocrCanvas(keepBlack(region, threshold), {
          whitelist: '0123456789.',
          psm: 7,
        })
      );
      if (value) {
        votes.set(value, (votes.get(value) || 0) + 1);
      }
    }
  }
  let best = null,
    bestCount = 0;
  for (const [value, count] of votes) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return {
    value: bestCount >= 2 ? best : null,
    agree: bestCount,
    distinct: [...votes.entries()].sort((a, b) => b[1] - a[1]),
  };
}

let perfect = 0;
for (const file of fs
  .readdirSync(PP)
  .filter((f) => /\.jpe?g$/i.test(f))
  .sort()) {
  const name = file.replace(/-PASSPORT\.jpe?g$/i, '');
  const img = await renderImage(PP + file);
  const start = process.hrtime.bigint();
  const r = readIssueDate(img);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const ok = r.value === TRUTH[name];
  if (ok) {
    perfect++;
  }
  console.log(
    `${name.padEnd(26)} -> ${r.value || '(unread)'} (${r.agree}x) [${ms.toFixed(0)}ms] truth=${TRUTH[name]} ${ok ? '✅' : r.value ? '❌' : '⚠️'}`
  );
  if (!ok) {
    console.log(
      `   top reads: ${r.distinct
        .slice(0, 5)
        .map(([v, c]) => `${v}(${c})`)
        .join('  ')}`
    );
  }
}
console.log(`\n${perfect}/5 perfect.`);
