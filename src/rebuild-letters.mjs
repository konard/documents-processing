#!/usr/bin/env node
// rebuild-letters.mjs
//
// Central letter build. For every person under documents-by-person/ it:
//   1. renders the English letter Markdown → EXPLANATION-LETTER.pdf (one page)
//   2. joins it with that person's Vietnam visa+ticket attachment and compresses
//      → EXPLANATION-LETTER-WITH-ATTACHMENTS(-COMPRESSED).pdf
//   3. renders the Russian reference letter (…-RU.md) → …-RU.pdf, when present
//      (Cyrillic needs the embedded Arial Unicode font)
//   4. copies the clean English letter PDF into the top-level letters/ folder as
//      <PERSON>-EXPLANATION-LETTER.pdf, so every final letter sits in one place
//
// The Markdown sources stay in documents-by-person/<PERSON>/explanation-letter/;
// letters/ holds only the built, upload-ready English PDFs.
//
// Usage:  node rebuild-letters.mjs [baseDir]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolveUnicodeFont } from './font-tools.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || path.dirname(__dirname);
const PERSON_ROOT = path.join(BASE, 'documents-by-person');
const LETTERS_DIR = path.join(BASE, 'letters');
// Local data (config + fonts cache) lives in <baseDir>/data/, never in src/.
const DATA_DIR = path.join(BASE, 'data');
// A wide-coverage font is needed only for the Russian (Cyrillic) letters; it is
// located in the system, the data cache, or fetched on demand (never in src/).
const FONT_PATH = await resolveUnicodeFont(DATA_DIR);

const run = (script, args) =>
  execFileSync('node', [path.join(__dirname, script), ...args], {
    stdio: 'inherit',
  });

fs.mkdirSync(LETTERS_DIR, { recursive: true });

const people = fs.existsSync(PERSON_ROOT)
  ? fs
      .readdirSync(PERSON_ROOT)
      .filter((name) => fs.statSync(path.join(PERSON_ROOT, name)).isDirectory())
      .sort()
  : [];

for (const person of people) {
  const letterDir = path.join(PERSON_ROOT, person, 'explanation-letter');
  const letterMd = path.join(letterDir, 'EXPLANATION-LETTER.md');
  if (!fs.existsSync(letterMd)) {
    console.warn(`⚠ ${person}: no EXPLANATION-LETTER.md, skipped`);
    continue;
  }

  const letterPdf = path.join(letterDir, 'EXPLANATION-LETTER.pdf');
  const withAttachments = path.join(
    letterDir,
    'EXPLANATION-LETTER-WITH-ATTACHMENTS.pdf'
  );
  const withAttachmentsCompressed = path.join(
    letterDir,
    'EXPLANATION-LETTER-WITH-ATTACHMENTS-COMPRESSED.pdf'
  );
  const vietnam = path.join(PERSON_ROOT, person, 'VIETNAM-VISA-AND-TICKET.pdf');

  console.log(`\n=== ${person} ===`);

  // 1) standalone letter (one page) — also produced as a side effect of the join,
  //    but render it explicitly so a person without an attachment still gets it.
  run('markdown-to-pdf.mjs', [letterMd, letterPdf, '--fit-one-page']);

  // 2) letter + Vietnam visa/ticket, then compressed under the 1 MB cap.
  if (fs.existsSync(vietnam)) {
    run('join-letter-attachments.mjs', [letterMd, withAttachments, vietnam]);
    run('compress-pdf.mjs', [withAttachments, withAttachmentsCompressed]);
  } else {
    console.warn(
      `⚠ ${person}: no VIETNAM-VISA-AND-TICKET.pdf — attachments PDF skipped`
    );
  }

  // 3) Russian reference letter, when a -RU.md exists (only when a -RU.md translation exists).
  const letterMdRu = path.join(letterDir, 'EXPLANATION-LETTER-RU.md');
  if (fs.existsSync(letterMdRu)) {
    const ruArgs = [
      letterMdRu,
      path.join(letterDir, 'EXPLANATION-LETTER-RU.pdf'),
      '--fit-one-page',
    ];
    if (FONT_PATH) {
      ruArgs.push(`--font=${FONT_PATH}`);
    } else {
      console.warn(
        `⚠ ${person}: no Unicode font available — Cyrillic may not render`
      );
    }
    run('markdown-to-pdf.mjs', ruArgs);
  }

  // 4) copy the clean English letter into the central letters/ folder.
  fs.copyFileSync(
    letterPdf,
    path.join(LETTERS_DIR, `${person}-EXPLANATION-LETTER.pdf`)
  );
}

console.log(`\nDone. Clean English letters collected in: ${LETTERS_DIR}`);
