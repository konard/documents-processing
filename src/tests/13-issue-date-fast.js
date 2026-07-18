// tests/13-issue-date-fast.js
// FAST version of the calibrated issue-date reader: calibrate y once on the
// crisp passports, then read each passport with a SMALL perspective grid around
// the calibrated y (few offsets/thresholds), strict regex+sanity, percentage
// consensus. Target: 4/5 correct in well under a second per passport.
//
// Run: node tests/13-issue-date-fast.js
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import { renderImage, readIssueDate, calibrateIssueDateY } from '../ocr-lib.js';

const BASE = fileURLToPath(new URL('../../', import.meta.url)); // project root (scripts are in src/tests/)
const PP = `${BASE}passports-photos/`;
const TRUTH = {
  'DOE-JOHN': '01.01.2020',
  'ROE-JANE': '02.02.2021',
  'SMITH-ALEX': '03.03.2022',
  'JONES-MARY': '04.04.2023',
  'BROWN-SAM': '05.05.2024',
};

const images = {};
for (const file of fs
  .readdirSync(PP)
  .filter((f) => /\.jpe?g$/i.test(f))
  .sort()) {
  images[file.replace(/-PASSPORT\.jpe?g$/i, '')] = await renderImage(PP + file);
}

const calibratedY = await calibrateIssueDateY(Object.values(images));
console.log(`calibrated y = ${calibratedY.toFixed(4)}\n`);

let perfect = 0,
  totalMs = 0;
for (const [name, img] of Object.entries(images)) {
  const start = process.hrtime.bigint();
  const result = readIssueDate(img, { calibratedY });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  totalMs += ms;
  const ok = result.value === TRUTH[name];
  if (ok) {
    perfect++;
  }
  console.log(
    `${name.padEnd(26)} -> ${result.value || '(unread)'} (${result.agree}/${result.validReads}, ${(result.share * 100).toFixed(0)}%) [${ms.toFixed(0)}ms] truth=${TRUTH[name]} ${ok ? '✅' : result.value ? '❌' : '⚠️'}`
  );
}
console.log(
  `\n${perfect}/5 perfect, ${(totalMs / 5).toFixed(0)}ms/passport avg.`
);
