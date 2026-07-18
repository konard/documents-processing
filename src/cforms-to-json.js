#!/usr/bin/env node
// cforms-to-json.js
//
// Turns each Form 'C' document into a structured JSON transcript.
//
// TWO SOURCES, auto-detected per file:
//   1. TEXT (preferred) — the source forms and their split pages carry a real
//      text layer, so every field is read EXACTLY from its label (Surname, Date of
//      birth, Passport No., Visa Number, …) via pdf.js. No OCR, no guessing.
//   2. OCR (fallback) — if a Form C is a scan/photo with no usable text layer
//      (an older-style image document), we fall back to the fast BLOCK-CROP OCR
//      method validated in tests/02-block-crops.js.
//
// Each transcript records _source so downstream steps know whether the values
// are exact (text) or machine-read (OCR, cross-checked against the visual read).
//
// Writes  transcripts/<NAME>-FORM-C.ocr.json
//
// Usage:  node cforms-to-json.js [baseDir]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  renderImage,
  ocrCanvas,
  regionCanvas,
  upscale,
  box,
} from './ocr-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Scripts live in src/; document folders live one level up in the project root.
const BASE = process.argv[2] || path.dirname(__dirname);
const FC_DIR = path.join(BASE, 'c-forms');
const OUT_DIR = path.join(BASE, 'transcripts');
fs.mkdirSync(OUT_DIR, { recursive: true });

const DATE_PATTERN = /\d{2}\/\d{2}\/\d{4}/g;

// ===========================================================================
// TEXT PATH — read the real text layer and pull each field by its label.
// ===========================================================================

async function readText(file) {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(file)) })
    .promise;
  const page = await doc.getPage(1);
  const text = (await page.getTextContent()).items
    .map((it) => it.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

// Pull the value that follows `label`, stopping before `next` (the label of the
// following field). Trimmed; returns null if not found.
function fieldBetween(text, label, next) {
  const re = new RegExp(`${label}\\s+(.+?)\\s+${next}`);
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

// complex by nature: extracts many independent Form-C fields in one pass;
// splitting it would fragment a flat list of field lookups.
// eslint-disable-next-line complexity
function parseFormCText(text) {
  const surname = fieldBetween(text, 'Surname', 'Given name');
  const given = fieldBetween(text, 'Given name', 'Sex');
  const sex = fieldBetween(text, 'Sex', 'Date of birth');
  const dob =
    (fieldBetween(text, 'Date of birth', 'Special Category') || '').match(
      DATE_PATTERN
    )?.[0] || null;
  const nationality = fieldBetween(text, 'Nationality', 'Address in country');

  // Passport Details section.
  const passportSection = text.slice(text.indexOf('Passport Details'));
  const passport =
    (passportSection.match(/Passport No\.\s+(\S+)/) || [])[1] || null;
  const passportIssue =
    (fieldBetween(passportSection, 'Date of Issue', 'Expiry Date') || '').match(
      DATE_PATTERN
    )?.[0] || null;
  const passportExpiry =
    (fieldBetween(passportSection, 'Expiry Date', 'Visa Details') || '').match(
      DATE_PATTERN
    )?.[0] || null;

  // Visa Details section.
  const visaSection = text.slice(text.indexOf('Visa Details'));
  const visaNumber =
    (visaSection.match(/Visa Number\s+(\S+)/) || [])[1] || null;
  const visaIssue =
    (fieldBetween(visaSection, 'Date of Issue', 'Valid Till') || '').match(
      DATE_PATTERN
    )?.[0] || null;
  const visaValidTill =
    (fieldBetween(visaSection, 'Valid Till', 'Visa Type') || '').match(
      DATE_PATTERN
    )?.[0] || null;
  const visaType = fieldBetween(visaSection, 'Visa Type', 'Place of Issue');
  const visaSubtype = fieldBetween(
    visaSection,
    'Visa Subtype',
    'Arrival Details'
  );

  // Arrival Details section.
  const arrivalSection = text.slice(text.indexOf('Arrival Details'));
  const arrivalIndia =
    (
      fieldBetween(
        arrivalSection,
        'Date of arrival in India',
        'Date of Arrival in Individual House'
      ) || ''
    ).match(DATE_PATTERN)?.[0] || null;

  return {
    surname,
    given,
    sex,
    dob,
    nationality,
    passport,
    passportIssue,
    passportExpiry,
    visaNumber,
    visaIssue,
    visaValidTill,
    visaType,
    visaSubtype,
    arrivalIndia,
    // Keep the shape the OCR path also produced, so downstream code is source-agnostic.
    visaDates: [visaIssue, visaValidTill].filter(Boolean),
  };
}

// ===========================================================================
// OCR PATH (fallback) — fast block crops (tests/02-block-crops.js).
// ===========================================================================

// Single-column value-region blocks (fractions), generous for scan variance.
const BLOCKS = {
  personal: box(0.26, 0.335, 0.36, 0.135, { scale: 2 }), // surname, given, sex, dob, nationality
  passport: box(0.1, 0.525, 0.55, 0.095, { scale: 2 }), // passport no + place + issue + expiry
  visa: box(0.1, 0.625, 0.88, 0.075, { scale: 2 }), // visa no, valid till, issue date, type
};
const readBlock = (img, b) =>
  ocrCanvas(upscale(regionCanvas(img, b), b.scale), { psm: 6 });

async function parseFormCOcr(file) {
  const image = await renderImage(file);
  const personalText = readBlock(image, BLOCKS.personal);
  const passportText = readBlock(image, BLOCKS.passport);
  const visaText = readBlock(image, BLOCKS.visa);

  const personalWords = personalText
    .replace(/\n/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const surname =
    personalWords.find(
      (word) =>
        /^[A-Z][A-Z-]{2,}$/.test(word) &&
        !/RUSSIAN|FEDERATION|MALE|FEMALE|SPECIAL|OTHERS/.test(word)
    ) || null;
  const dateOfBirth = (personalText.match(DATE_PATTERN) || [])[0] || null;

  const passportNumber =
    (passportText.match(/\b(\d{2}[A-Z]\d{6,7}|\d{9})\b/) || [])[1] || null;
  const passportDates = passportText.match(DATE_PATTERN) || [];

  const visaNumber =
    (visaText.match(/\b(VL\d{6,7}|901[A-Z0-9]{5,6})\b/) || [])[1] || null;
  const visaDates = visaText.match(DATE_PATTERN) || [];

  return {
    fields: {
      surname,
      dob: dateOfBirth,
      passport: passportNumber,
      passportIssue: passportDates[0] || null,
      passportExpiry: passportDates[1] || null,
      visaNumber,
      visaDates,
    },
    raw: {
      personal: personalText.replace(/\n/g, ' | '),
      passport: passportText.replace(/\n/g, ' | '),
      visa: visaText.replace(/\n/g, ' | '),
    },
  };
}

// ===========================================================================
// DRIVER — per file: try text, fall back to OCR.
// ===========================================================================

const formFiles = fs
  .readdirSync(FC_DIR)
  .filter((fileName) => fileName.endsWith('-FORM-C.pdf'))
  .sort();

for (const fileName of formFiles) {
  const personName = fileName.replace(/-FORM-C\.pdf$/, '');
  const filePath = path.join(FC_DIR, fileName);

  // A Form C is "text" if the page carries the section labels we key off of.
  const text = await readText(filePath).catch(() => '');
  const hasTextLayer =
    /Personal Details/.test(text) && /Passport Details/.test(text);

  let transcript;
  if (hasTextLayer) {
    const f = parseFormCText(text);
    transcript = {
      _source: 'text (pdf.js — exact, from embedded text layer)',
      _document: `c-forms/${fileName}`,
      surname: f.surname,
      given: f.given,
      sex: f.sex,
      dob: f.dob,
      nationality: f.nationality,
      passport: f.passport,
      passportIssue: f.passportIssue,
      passportExpiry: f.passportExpiry,
      visaNumber: f.visaNumber,
      visaIssue: f.visaIssue,
      visaValidTill: f.visaValidTill,
      visaType: f.visaType,
      visaSubtype: f.visaSubtype,
      arrivalIndia: f.arrivalIndia,
      visaDates: f.visaDates,
    };
    console.log(
      `✓ ${personName} [text]: ${f.surname} ${f.given} | dob ${f.dob} | pass ${f.passport} passIssue ${f.passportIssue} | visa# ${f.visaNumber} issue ${f.visaIssue} till ${f.visaValidTill}`
    );
  } else {
    const { fields, raw } = await parseFormCOcr(filePath);
    transcript = {
      _source:
        'OCR (tesseract, block crops — see tests/02; no text layer in this file)',
      _document: `c-forms/${fileName}`,
      surname: fields.surname,
      dob: fields.dob,
      passport: fields.passport,
      passportIssue: fields.passportIssue,
      passportExpiry: fields.passportExpiry,
      visaNumber: fields.visaNumber,
      visaDates: fields.visaDates,
      _raw: raw,
    };
    console.log(
      `✓ ${personName} [OCR]: surname=${fields.surname} dob=${fields.dob} pass=${fields.passport} passIssue=${fields.passportIssue || '?'} visa#=${fields.visaNumber} visaDates=[${fields.visaDates.join(' ')}]`
    );
  }

  fs.writeFileSync(
    path.join(OUT_DIR, `${personName}-FORM-C.ocr.json`),
    JSON.stringify(transcript, null, 2)
  );
}

console.log(`\nDone. Form C transcripts in: ${OUT_DIR}`);
