// tests/07-passport-mrz.js
// Verify MRZ OCR for every passport with the CURRENT library primitives (not the
// shim). Crop the MRZ band, OCR with MRZ charset, parse + check digits.
// Run: node tests/07-passport-mrz.js
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import {
  renderImage,
  regionCanvas,
  upscale,
  box,
  ocrCanvas,
  parseMrzLine1,
  parseMrzLine2,
} from '../src/ocr-lib.mjs';

const BASE = fileURLToPath(new URL('../', import.meta.url)); // project root (scripts are in tests/)
const PP = `${BASE}passports-photos/`;
const MRZ_WL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';
const MRZ_BOX = box(0.0, 0.883, 1.0, 0.112, { scale: 3 });

for (const f of fs
  .readdirSync(PP)
  .filter((x) => /\.jpe?g$/i.test(x))
  .sort()) {
  const img = await renderImage(PP + f);
  const txt = ocrCanvas(upscale(regionCanvas(img, MRZ_BOX), 3), {
    whitelist: MRZ_WL,
    psm: 6,
  });
  const lines = txt
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const l1 = lines.find((l) => /^P/.test(l)) || '';
  const l2 =
    lines.find((l) => /^[A-Z0-9<]{9}\d[A-Z<]{3}\d{6}/.test(l)) ||
    lines[lines.length - 1] ||
    '';
  const nm = parseMrzLine1(l1) || {};
  const dt = parseMrzLine2(l2) || {};
  const ok = dt.passportCheckOk && dt.dobCheckOk && dt.expiryCheckOk;
  console.log(
    `${f.replace('-PASSPORT.jpg', '').padEnd(26)} #${dt.passportNumber || '?'} ${nm.surname || '?'} ${nm.given || '?'} dob=${dt.dob || '?'} ${ok ? '✓ all checks' : `⚠ ${JSON.stringify({ p: dt.passportCheckOk, d: dt.dobCheckOk, e: dt.expiryCheckOk })}`}`
  );
  if (!dt.passportNumber) {
    console.log(`   L2 raw: "${l2}"`);
  }
}
