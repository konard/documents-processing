#!/usr/bin/env node
// build-markdown-transcripts.mjs
//
// Renders a full, human-readable Markdown transcript (with tables) for every
// document, from the per-document JSON transcripts in transcripts/. Each image
// document shows its OCR layer, its visual layer, or both side by side; text
// documents show their code-extracted fields.
//
// Output:  transcripts/markdown/<NAME>-<DOC>.md   and an index README.md
//
// Usage:  node build-markdown-transcripts.mjs [baseDir]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// Scripts live in src/; the transcripts/ folder lives one level up in the
// project root. Default the base there.
const baseDir = process.argv[2] || path.dirname(scriptDir);
const transcriptsDir = path.join(baseDir, 'transcripts');
const markdownDir = path.join(transcriptsDir, 'markdown');
fs.mkdirSync(markdownDir, { recursive: true });

const readJson = (fileName) =>
  JSON.parse(fs.readFileSync(path.join(transcriptsDir, fileName), 'utf8'));

// Group the JSON transcript files by person + document type; keep every layer.
const documents = {}; // key `${person}|${docType}` -> { person, docType, layers: {ocr, visual, text} }
for (const fileName of fs
  .readdirSync(transcriptsDir)
  .filter((name) => name.endsWith('.json'))) {
  const parsed = fileName.match(
    /^(.+?)-(PASSPORT|FORM-C|INDIA-VISA|INDIA-ENTRY|VIETNAM-TICKET)\.(ocr|visual|text)\.json$/
  );
  if (!parsed) {
    continue;
  }
  const [, person, docType, layer] = parsed;
  const key = `${person}|${docType}`;
  (documents[key] ||= { person, docType, layers: {} }).layers[layer] =
    readJson(fileName);
}

// Human labels for each raw field key, in the order they should appear.
const FIELD_LABELS = {
  surname: 'Surname',
  given: 'Given name',
  name: 'Full name',
  passenger: 'Passenger',
  number: 'Passport number',
  passport: 'Passport number',
  passportOnPage: 'Passport number (on page)',
  dob: 'Date of birth',
  sex: 'Sex',
  nationality: 'Nationality',
  issue: 'Date of issue',
  expiry: 'Date of expiry',
  passportIssue: 'Passport issue date',
  passportExpiry: 'Passport expiry date',
  placeOfBirth: 'Place of birth',
  visaNumber: 'Visa number',
  visaNo: 'Visa number',
  eta: 'ETA number',
  app: 'Application ID',
  visaIssue: 'Visa issue date',
  visaValidTill: 'Visa valid till',
  visaType: 'Visa type',
  visaSubtype: 'Visa subtype',
  visaDates: 'Visa dates (block)',
  type: 'Visa type',
  arrivalIndia: 'Date of arrival in India',
  ticketNo: 'Ticket number',
  pnr: 'Booking code (PNR)',
  mrz_name: 'MRZ name line',
  mrz_number: 'MRZ passport number',
};
const HIDDEN_KEYS = new Set([
  '_source',
  '_document',
  '_raw',
  '_checkDigits',
  '_issueOcrRaw',
  '_dobReVerified',
  '_note',
  'mrz',
  '_issueConsensus',
  '_issueSource',
]);

const DOC_TITLES = {
  PASSPORT: 'Russian passport (data page)',
  'FORM-C': "Form 'C' — Arrival Report of Foreigner",
  'INDIA-VISA': 'India visa',
  'INDIA-ENTRY': 'India e-Visa entry stamp',
  'VIETNAM-TICKET': 'Vietnam flight ticket',
};
const escapePipes = (value) => String(value).replace(/\|/g, '\\|');

// Render one layer object as a Markdown field/value table.
function renderLayerTable(layerData) {
  const rows = [];
  for (const [key, value] of Object.entries(layerData)) {
    if (HIDDEN_KEYS.has(key)) {
      continue;
    }
    if (value === null || value === undefined || value === '') {
      continue;
    }
    const label = FIELD_LABELS[key] || key;
    const shown = Array.isArray(value) ? value.join(', ') : value;
    rows.push(`| ${label} | ${escapePipes(shown)} |`);
  }
  return ['| Field | Value |', '|---|---|', ...rows].join('\n');
}

// Render a document's transcript: title, source note, per-layer tables, and the
// raw MRZ / raw OCR text when present (full fidelity).
// complex by nature: one linear pass assembling many optional transcript
// sections; splitting it would only scatter the layout logic.
// eslint-disable-next-line complexity
function renderDocument(entry) {
  const { person, docType, layers } = entry;
  const lines = [];
  lines.push(`# ${person} — ${DOC_TITLES[docType] || docType}`, '');

  const layerOrder = ['visual', 'ocr', 'text'];
  const layerTitle = {
    visual: 'Visual read (from scan)',
    ocr: 'OCR (tesseract)',
    text: 'Extracted text (pdf.js)',
  };
  // Title a layer by what its source actually is, not by which slot it sits in:
  // a Form C stored in the `.ocr` slot may in fact be an exact text-layer read.
  const titleFor = (layerName, layerData) => {
    const source =
      typeof layerData._source === 'string' ? layerData._source : '';
    if (layerName === 'ocr' && source.startsWith('text')) {
      return 'Extracted text (pdf.js)';
    }
    if (layerName === 'ocr' && source.startsWith('OCR')) {
      return 'OCR (tesseract)';
    }
    return layerTitle[layerName];
  };
  for (const layerName of layerOrder) {
    const layerData = layers[layerName];
    if (!layerData) {
      continue;
    }
    lines.push(`## ${titleFor(layerName, layerData)}`);
    if (layerData._source) {
      lines.push(`_Source: ${layerData._source}_`, '');
    }
    lines.push(renderLayerTable(layerData), '');

    // Full-fidelity extras.
    if (layerData.mrz) {
      lines.push(
        '**Machine-readable zone (MRZ):**',
        '',
        '```',
        layerData.mrz.line1 || '',
        layerData.mrz.line2 || '',
        '```',
        ''
      );
      if (layerData._checkDigits) {
        const digits = layerData._checkDigits;
        lines.push(
          `MRZ check digits — passport ${digits.passport ? '✓' : '✗'}, DOB ${digits.dob ? '✓' : '✗'}, expiry ${digits.expiry ? '✓' : '✗'}.`,
          ''
        );
      }
    }
    // Note how the issue date was obtained (OCR consensus or a visual override).
    if (layerData._issueSource) {
      const consensus = layerData._issueConsensus;
      const confidence =
        consensus && consensus.validReads
          ? ` (OCR consensus ${consensus.agree}/${consensus.validReads}, ${Math.round(consensus.share * 100)}%)`
          : '';
      lines.push(
        `> **Date of issue** — ${layerData._issueSource.startsWith('override') ? layerData._issueSource : `read by ${layerData._issueSource}${confidence}`}`,
        ''
      );
    }
    if (layerData._raw) {
      lines.push('<details><summary>Raw OCR text per block</summary>', '');
      for (const [block, text] of Object.entries(layerData._raw)) {
        lines.push(`- **${block}**: \`${escapePipes(text)}\``);
      }
      lines.push('', '</details>', '');
    }
  }
  return lines.join('\n');
}

// ---- write per-document transcripts + index -------------------------------

const written = [];
for (const entry of Object.values(documents).sort((a, b) =>
  (a.person + a.docType).localeCompare(b.person + b.docType)
)) {
  const fileName = `${entry.person}-${entry.docType}.md`;
  fs.writeFileSync(path.join(markdownDir, fileName), renderDocument(entry));
  written.push({ ...entry, fileName });
}

// index grouped by person
const indexLines = [
  '# Document transcripts',
  '',
  'Full text transcript of every document, rendered from the OCR / visual / text-extraction layers in `transcripts/`.',
  '',
];
const byPerson = {};
for (const entry of written) {
  (byPerson[entry.person] ||= []).push(entry);
}
for (const [person, entries] of Object.entries(byPerson).sort()) {
  indexLines.push(`## ${person}`);
  for (const entry of entries.sort((a, b) =>
    a.docType.localeCompare(b.docType)
  )) {
    indexLines.push(
      `- [${DOC_TITLES[entry.docType] || entry.docType}](./${entry.fileName}) (${Object.keys(entry.layers).join(' + ')})`
    );
  }
  indexLines.push('');
}
fs.writeFileSync(path.join(markdownDir, 'README.md'), indexLines.join('\n'));

console.log(
  `Wrote ${written.length} Markdown transcript(s) + index to: ${markdownDir}`
);
