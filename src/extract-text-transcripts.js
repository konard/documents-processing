#!/usr/bin/env node
// extract-text-transcripts.js
//
// For the TEXT-bearing documents (India ETAs and Vietnam tickets) — which have
// a real embedded text layer — extract the fields BY CODE and persist a
// transcript per document. No OCR, no human reading: pdf.js reads the text.
//
// Outputs to  transcripts/<NAME>-<DOC>.text.json
//   INDIA-VISA (ETA holders only) and VIETNAM-TICKET
//
// Usage:  node extract-text-transcripts.js [baseDir]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Scripts live in src/; document folders live one level up in the project root.
const BASE = process.argv[2] || path.dirname(__dirname);
const OUT_DIR = path.join(BASE, 'transcripts');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function fullText(file) {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(file)) })
    .promise;
  let all = '';
  for (let i = 1; i <= doc.numPages; i++) {
    all += ` ${(await doc.getPage(i).then((p) => p.getTextContent())).items
      .map((x) => x.str)
      .join(' ')}`;
  }
  return all.replace(/\s+/g, ' ').trim();
}

const SRC = 'code-extracted text (pdf.js)';
let n = 0;

// Vietnam tickets (from vietnam-visa-and-ticket combined doc, or tickets/)
const TDIR = path.join(BASE, 'tickets');
for (const f of fs.existsSync(TDIR)
  ? fs.readdirSync(TDIR).filter((x) => x.endsWith('-TICKET.pdf'))
  : []) {
  const name = f.replace(/-TICKET\.pdf$/, '');
  const t = await fullText(path.join(TDIR, f));
  const rec = {
    _source: SRC,
    _document: `tickets/${f}`,
    passenger:
      (t.match(/Ticket number\s+([A-Z][A-Z ]+?)\s+\d{6,}/) || [])[1] || null,
    passport:
      (t.match(/Ticket number\s+[A-Z][A-Z ]+?\s+(\d{6,9})/) || [])[1] || null,
    dob: (t.match(/(\d{2}\.\d{2}\.\d{4})\s+TE/) || [])[1] || null,
    ticketNo: (t.match(/TE\s+(\d{10,})/) || [])[1] || null,
    // Booking reference / PNR: a 6-char alphanumeric code that follows a
    // "Booking reference" / "Reservation code" / "PNR" label. Read from the
    // document itself — never hardcoded to a specific booking.
    pnr:
      (t.match(
        /(?:Booking reference|Reservation code|PNR|Record locator)\s*:?\s*([A-Z0-9]{6})\b/i
      ) || [])[1] || null,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, `${name}-VIETNAM-TICKET.text.json`),
    JSON.stringify(rec, null, 2)
  );
  n++;
}

// India ETAs (india-visas/*-INDIA-VISA.pdf that have ETA text)
const VDIR = path.join(BASE, 'india-visas');
for (const f of fs
  .readdirSync(VDIR)
  .filter((x) => x.endsWith('-INDIA-VISA.pdf'))) {
  const name = f.replace(/-INDIA-VISA\.pdf$/, '');
  const t = await fullText(path.join(VDIR, f));
  if (!t.includes('Electronic Travel Authorization')) {
    continue;
  } // VL stickers -> visual transcript
  const rec = {
    _source: SRC,
    _document: `india-visas/${f}`,
    type: 'ETA',
    name: (t.match(/Dear ([A-Z ]+?) Your application/) || [])[1] || null,
    passport: (t.match(/Passport Number\s*:?\s*(\w+)/) || [])[1] || null,
    eta: (t.match(/ETA Number\s*:?\s*(\w+)/) || [])[1] || null,
    app: (t.match(/Application Id\s*:?\s*(\w+)/) || [])[1] || null,
    issue: (t.match(/Date of issue of ETA\s*:?-?\s*([\w/]+)/) || [])[1] || null,
    expiry:
      (t.match(/Date of expiry of ETA\s*:?-?\s*([\w/]+)/) || [])[1] || null,
    nationality:
      (t.match(/Nationality\s*:?\s*([A-Z ]+?)\s+Visa Type/) || [])[1] || null,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, `${name}-INDIA-VISA.text.json`),
    JSON.stringify(rec, null, 2)
  );
  n++;
}

console.log(`Wrote ${n} text transcript(s) to: ${OUT_DIR}`);
