// tests/10-issue-date-keepblack.js
// Read the passport DATE OF ISSUE (printed over guilloché, not in the MRZ) using
// the keepBlack preprocessor (strip everything not near-black) + consensus
// (random offset/rotation, stop at 2 agreeing reads). Score against truth.
//
// Run: node tests/10-issue-date-keepblack.js
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import { renderImage, box, readFieldConsensus } from '../src/ocr-lib.mjs';

const BASE = fileURLToPath(new URL('../', import.meta.url)); // project root (scripts are in tests/)
const PP = `${BASE}passports-photos/`;

const TRUTH = {
  'DOE-JOHN': '01.01.2020', // partly faint on scan
  'ROE-JANE': '02.02.2021',
  'SMITH-ALEX': '03.03.2022',
  'JONES-MARY': '04.04.2023',
  'BROWN-SAM': '05.05.2024',
};

// tight date-line box (just the printed issue date row)
const ISSUE_BOX = box(0.3, 0.789, 0.34, 0.024, { scale: 4 });
const onlyDate = (t) => {
  const m = t.replace(/ /g, '').match(/(\d{2})\.?(\d{2})\.?(\d{4})/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : '';
};

let perfect = 0;
for (const file of fs
  .readdirSync(PP)
  .filter((f) => /\.jpe?g$/i.test(f))
  .sort()) {
  const name = file.replace(/-PASSPORT\.jpe?g$/i, '');
  const img = await renderImage(PP + file);
  const start = process.hrtime.bigint();
  const result = readFieldConsensus(img, ISSUE_BOX, {
    whitelist: '0123456789.',
    psm: 7,
    maxAttempts: 20,
    agreeTarget: 2,
    jitterPx: 3,
    jitterDeg: 1.2,
    preprocess: ['keepBlack', 'keepBlack110', 'keepBlack'],
    normalize: onlyDate,
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const ok = result.value === TRUTH[name];
  if (ok) {
    perfect++;
  }
  console.log(
    `${name.padEnd(26)} -> ${result.value || '(unread)'}  [${result.attempts} tries, ${result.agree} agree, ${ms.toFixed(0)}ms]  truth=${TRUTH[name]} ${ok ? '✅' : result.value ? '❌ WRONG' : '⚠️ unread'}`
  );
  if (!ok) {
    console.log(
      `   distinct reads: ${[...new Set(result.candidates.map((c) => c.value).filter(Boolean))].join(' | ') || '(none)'}`
    );
  }
}
console.log(`\n${perfect}/5 issue dates read perfectly.`);
