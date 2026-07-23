#!/usr/bin/env node
// ocr-passports.mjs
//
// OCRs each Russian passport data page using MAPPED regions (much better than
// full-page OCR):
//   - MRZ band (bottom of the page): the two machine-readable lines, OCR'd with
//     the MRZ charset, then parsed WITH CHECK-DIGIT VALIDATION. The MRZ yields
//     surname, given name, passport number, nationality, DOB, sex, expiry.
//   - Date-of-issue field crop: the issue date is NOT in the MRZ, so a small
//     region on the data page is OCR'd separately for digits/dots.
//
// Writes one transcript per passport to  transcripts/<NAME>-PASSPORT.ocr.json
//
// Usage:  node ocr-passports.mjs [baseDir]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderImage,
  regionCanvas,
  upscale,
  ocrCanvas,
  parseMrzLine1,
  parseMrzLine2,
  calibrateIssueDateY,
  readIssueDate,
} from './ocr-lib.mjs';

const cropCanvas = (image, region, scale = 3) =>
  upscale(regionCanvas(image, region), scale);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// Scripts live in src/; document folders (passports-photos/, transcripts/, …)
// and config files live one level up in the project root. Default the base there.
const baseDir = process.argv[2] || path.dirname(scriptDir);
const passportsDir = path.join(baseDir, 'passports-photos');
const outputDir = path.join(baseDir, 'transcripts');
fs.mkdirSync(outputDir, { recursive: true });

// Load overrides (fields OCR cannot read; filled from the visual read).
// The overrides file lives next to the scripts in src/, not with the documents.
const overridesPath = path.join(scriptDir, 'ocr-overrides.json');
const overrides = fs.existsSync(overridesPath)
  ? JSON.parse(fs.readFileSync(overridesPath, 'utf8')).overrides || {}
  : {};

const MRZ_REGION = { x: 0.0, y: 0.883, w: 1.0, h: 0.112 };
const MRZ_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';

const passportFiles = fs
  .readdirSync(passportsDir)
  .filter((name) => /\.jpe?g$/i.test(name))
  .sort();

// Pre-render all passports (needed both to calibrate the issue-date row and to read each).
const images = {};
for (const fileName of passportFiles) {
  images[fileName] = await renderImage(path.join(passportsDir, fileName));
}

// Calibrate the date-of-issue row position once, from the passports where it reads cleanly.
const calibratedIssueY = await calibrateIssueDateY(Object.values(images));
console.log(
  `Calibrated date-of-issue row y = ${calibratedIssueY.toFixed(4)}\n`
);

for (const fileName of passportFiles) {
  const personName = fileName.replace(/-PASSPORT\.jpe?g$/i, '');
  const image = images[fileName];

  // --- MRZ (surname, given, number, nationality, DOB, sex, expiry) ---
  const mrzText = ocrCanvas(cropCanvas(image, MRZ_REGION, 3), {
    whitelist: MRZ_WHITELIST,
    psm: 6,
  });
  const mrzLines = mrzText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const nameLineRaw =
    mrzLines.find((line) => /^P/.test(line)) || mrzLines[0] || '';
  const dataLineRaw =
    mrzLines.find((line) => /^[A-Z0-9<]{9}\d[A-Z<]{3}\d{6}/.test(line)) ||
    mrzLines[1] ||
    mrzLines[mrzLines.length - 1] ||
    '';
  const nameFields = parseMrzLine1(nameLineRaw) || {};
  const dataFields = parseMrzLine2(dataLineRaw) || {};

  // --- Date of issue (NOT in MRZ): calibrated keepBlack + perspective + consensus ---
  const issueResult = readIssueDate(image, { calibratedY: calibratedIssueY });
  let issue = issueResult.value; // null if OCR could not confirm it
  let issueSource = issue ? 'OCR (keepBlack + calibrate + consensus)' : null;

  // Fall back to an override for fields OCR cannot read (e.g. overprinted date).
  const overrideKey = `${personName}/PASSPORT/issue`;
  if (!issue && overrides[overrideKey]) {
    issue = overrides[overrideKey].value;
    issueSource = `override (visual, OCR blocked): ${overrides[overrideKey].reason}`;
  }

  const transcript = {
    _document: `passports-photos/${fileName}`,
    _source:
      'OCR (tesseract, MRZ + check digits; issue via keepBlack/consensus; overrides for blocked fields)',
    mrz: { line1: nameLineRaw, line2: dataLineRaw },
    surname: nameFields.surname || null,
    given: nameFields.given || null,
    number: dataFields.passportNumber || null,
    nationality:
      dataFields.nationality === 'RUS'
        ? 'RUSSIAN FEDERATION'
        : dataFields.nationality || null,
    dob: dataFields.dob || null, // ISO yyyy-mm-dd (from MRZ)
    sex: dataFields.sex || null,
    expiry: dataFields.expiry || null, // ISO yyyy-mm-dd (from MRZ)
    issue, // dd.mm.yyyy (OCR or override)
    _issueSource: issueSource,
    _issueConsensus: {
      value: issueResult.value,
      agree: issueResult.agree,
      validReads: issueResult.validReads,
      share: +issueResult.share.toFixed(2),
    },
    _checkDigits: {
      passport: dataFields.passportCheckOk,
      dob: dataFields.dobCheckOk,
      expiry: dataFields.expiryCheckOk,
    },
  };

  const allChecksPass =
    dataFields.passportCheckOk &&
    dataFields.dobCheckOk &&
    dataFields.expiryCheckOk;
  fs.writeFileSync(
    path.join(outputDir, `${personName}-PASSPORT.ocr.json`),
    JSON.stringify(transcript, null, 2)
  );
  const issueLabel = issue
    ? `${issue}${issueSource.startsWith('override') ? ' (override)' : ` (${(issueResult.share * 100).toFixed(0)}%)`}`
    : '?';
  console.log(
    `✓ ${personName}: ${transcript.surname} ${transcript.given} | #${transcript.number} | dob ${transcript.dob} | exp ${transcript.expiry} | issue ${issueLabel} | MRZ checks ${allChecksPass ? 'ALL OK ✓' : `P=${dataFields.passportCheckOk} D=${dataFields.dobCheckOk} E=${dataFields.expiryCheckOk}`}`
  );
}

console.log(`\nDone. Passport OCR transcripts in: ${outputDir}`);
