// tests/08-consensus-issue-date.js
// The passport "date of issue" sits on red security print and was MISSING from
// the OCR layer. Test the consensus reader (random offset + rotation + varied
// preprocessing, stop at 2 agreeing attempts) on this hard field for all 5
// passports. Report the agreed value, how many attempts it took, and the truth.
//
// Run: node tests/08-consensus-issue-date.js
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import { renderImage, box, readFieldConsensus } from '../src/ocr-lib.js';

const BASE = fileURLToPath(new URL('../', import.meta.url)); // project root (scripts are in tests/)
const PP = `${BASE}passports-photos/`;

// Known truths (from careful visual reading) to score the consensus reader.
const TRUTH = {
  'DOE-JOHN': '01.01.2020', // partially legible on scan
  'ROE-JANE': '02.02.2021',
  'SMITH-ALEX': '03.03.2022',
  'JONES-MARY': '04.04.2023',
  'BROWN-SAM': '05.05.2024',
};

// Date-of-issue region on the data page (below DOB, left column).
const ISSUE_BOX = box(0.3, 0.79, 0.34, 0.055, { scale: 4 });
const onlyDate = (text) => {
  const m = text.match(/(\d{2})[.\s](\d{2})[.\s](\d{4})/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : '';
};

for (const file of fs
  .readdirSync(PP)
  .filter((f) => /\.jpe?g$/i.test(f))
  .sort()) {
  const name = file.replace(/-PASSPORT\.jpe?g$/i, '');
  const img = await renderImage(PP + file);
  const start = process.hrtime.bigint();
  const result = readFieldConsensus(img, ISSUE_BOX, {
    whitelist: '0123456789. ',
    psm: 7,
    maxAttempts: 20,
    agreeTarget: 2,
    normalize: onlyDate,
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const truth = TRUTH[name];
  const ok = result.value && result.value === truth;
  console.log(
    `${name.padEnd(26)} -> ${result.value || '(unread)'}  [${result.attempts} tries, ${result.agree} agree, ${ms.toFixed(0)}ms]  truth=${truth} ${ok ? '✅' : result.value ? '❌ WRONG' : '⚠️ unread'}`
  );
  if (!ok && result.candidates) {
    const seen = [
      ...new Set(result.candidates.map((c) => c.value).filter(Boolean)),
    ];
    console.log(`   distinct reads: ${seen.join(' | ') || '(none)'}`);
  }
}
