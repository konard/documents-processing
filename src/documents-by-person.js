#!/usr/bin/env node
// documents-by-person.js
//
// Builds a  documents-by-person/  tree: one folder per person, each containing
// that person's documents COPIED from the other folders and given a name that is
// just the document type (the person-name prefix is dropped, since the folder
// already names the person).
//
// Per person the folder gets (when the source exists):
//   PHOTO.jpg                       <- photos/<NAME>-PHOTO.jpg
//   PASSPORT-AND-INDIA-VISA.pdf     <- passports-and-visas/<NAME>-PASSPORT-AND-VISA.pdf
//   FORM-C.pdf                      <- c-forms/<NAME>-FORM-C.pdf
//   VIETNAM-VISA-AND-TICKET.pdf     <- vietnam-visa-and-ticket/<NAME>-VISA-AND-TICKET.pdf
//
// Originals are left untouched — files are copied, not moved.
//
// Usage:  node documents-by-person.js [baseDir]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Scripts live in src/; document folders live one level up in the project root.
const BASE = process.argv[2] || path.dirname(__dirname);
const OUT_DIR = path.join(BASE, 'documents-by-person');

// Each document: which folder it lives in, the suffix it currently has
// (after the <NAME> prefix), and the file name it should get in the person
// folder. `srcSuffix` and `outName` are kept separate so we can rename e.g.
// "-PASSPORT-AND-VISA.pdf" -> "PASSPORT-AND-INDIA-VISA.pdf".
const DOCS = [
  { dir: 'photos', srcSuffix: '-PHOTO.jpg', outName: 'PHOTO.jpg' },
  {
    dir: 'passports-and-visas',
    srcSuffix: '-PASSPORT-AND-VISA.pdf',
    outName: 'PASSPORT-AND-INDIA-VISA.pdf',
  },
  { dir: 'c-forms', srcSuffix: '-FORM-C.pdf', outName: 'FORM-C.pdf' },
  {
    dir: 'vietnam-visa-and-ticket',
    srcSuffix: '-VISA-AND-TICKET.pdf',
    outName: 'VIETNAM-VISA-AND-TICKET.pdf',
  },
];

// ---- discover the set of people from every source folder ------------------

const people = new Set();
for (const { dir, srcSuffix } of DOCS) {
  const p = path.join(BASE, dir);
  if (!fs.existsSync(p)) {
    continue;
  }
  for (const f of fs.readdirSync(p)) {
    if (f.endsWith(srcSuffix)) {
      people.add(f.slice(0, -srcSuffix.length));
    }
  }
}

const names = [...people].sort();
if (names.length === 0) {
  console.error('No source documents found. Nothing to do.');
  process.exit(1);
}

// ---- copy each person's documents into their folder -----------------------

fs.mkdirSync(OUT_DIR, { recursive: true });
let copied = 0;

for (const name of names) {
  const personDir = path.join(OUT_DIR, name);
  fs.mkdirSync(personDir, { recursive: true });
  const got = [];
  const missing = [];

  for (const { dir, srcSuffix, outName } of DOCS) {
    const srcPath = path.join(BASE, dir, `${name}${srcSuffix}`);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(personDir, outName));
      got.push(outName);
      copied++;
    } else {
      missing.push(outName);
    }
  }

  const miss = missing.length ? `  (missing: ${missing.join(', ')})` : '';
  console.log(`✓ ${name}/  [${got.join(', ')}]${miss}`);
}

console.log(
  `\nDone. ${names.length} person folder(s), ${copied} file(s) copied into:\n  ${OUT_DIR}`
);
