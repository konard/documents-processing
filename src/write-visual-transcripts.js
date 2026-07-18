#!/usr/bin/env node
// write-visual-transcripts.js
//
// Emits one VISUAL-READ transcript file per image-only document, derived from
// match-checks-data.json (Claude's careful reading of each scan). These are the
// human/authoritative layer that the OCR reads are cross-checked against.
//
// Outputs to  transcripts/<NAME>-<DOC>.visual.json
//   PASSPORT, FORM-C, INDIA-VISA (VL sticker only), INDIA-ENTRY
// (ETAs and tickets are NOT here — they have real text and are read by code.)
//
// Usage:  node write-visual-transcripts.js [baseDir]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Scripts live in src/; document folders (transcripts/) live one level up in
// the project root, but the visual-read data file lives next to the scripts.
const BASE = process.argv[2] || path.dirname(__dirname);
const DATA_PATH = path.join(__dirname, 'match-checks-data.json');
if (!fs.existsSync(DATA_PATH)) {
  console.error(`Missing ${DATA_PATH}`);
  console.error(
    'Copy match-checks-data.example.json to match-checks-data.json and fill in your own visual-read document data.'
  );
  process.exit(1);
}
const DATA = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const OUT_DIR = path.join(BASE, 'transcripts');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SRC = 'visual read (Claude, from scan)';
let n = 0;
const write = (name, doc, obj) => {
  fs.writeFileSync(
    path.join(OUT_DIR, `${name}-${doc}.visual.json`),
    JSON.stringify({ _source: SRC, ...obj }, null, 2)
  );
  n++;
};

for (const [name, p] of Object.entries(DATA.people)) {
  // Passport data page
  if (p.passport) {
    write(name, 'PASSPORT', {
      _document: `passports-photos/${name}-PASSPORT.jpg`,
      ...p.passport,
    });
  }
  // Form C
  if (p.formC) {
    write(name, 'FORM-C', {
      _document: `c-forms/${name}-FORM-C.pdf`,
      ...p.formC,
    });
  }
  // India visa — only the VL stickers are image-only (ETAs have text)
  if (p.indiaVisa && p.indiaVisa.type === 'VL') {
    write(name, 'INDIA-VISA', {
      _document: `india-visas/${name}-INDIA-VISA.pdf`,
      ...p.indiaVisa,
    });
  }
  // India entry stamp
  if (p.indiaEntryStamp) {
    write(name, 'INDIA-ENTRY', {
      _document: `passport-entries/${name}-PASSPORT-ENTRY.pdf`,
      ...p.indiaEntryStamp,
    });
  }
}

console.log(`Wrote ${n} visual transcript(s) to: ${OUT_DIR}`);
