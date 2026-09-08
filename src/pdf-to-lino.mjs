#!/usr/bin/env node
// pdf-to-lino.mjs
//
// Turns a PDF whose text can be extracted into links notation.
//
// The e-visa site hands back the finished application as a PDF, and that PDF
// is the only record of what was actually submitted. Read back into a record,
// it can be compared against the passport it was built from, fed to another
// form, or kept beside the applicant files that already live in lino.
//
// Two readings are offered:
//
//   --form na1a   The Vietnam e-visa application form (NA1a). Labelled fields
//                 are picked out by their numbering and names, and the result
//                 uses the same keys as the rest of the toolkit, so a form
//                 read back here can be diffed against the record it came
//                 from.
//   --form auto   Every `Label: value` pair the page holds. Nothing is assumed
//                 about the document, so an unfamiliar PDF still gives up what
//                 it has.
//
// Usage:
//   node src/pdf-to-lino.mjs <input.pdf> [more.pdf ...] [options]
//
//   --form <na1a|auto>  How to read the page (default: na1a when it looks
//                       like one, otherwise auto).
//   --out <dir>         Write <name>.lino per input; otherwise print.
//   --json              Print JSON in place of lino.
//
// Text is taken with `pdftotext -layout`, which keeps the two-column shape the
// form is printed in. A scanned PDF holds no text, and that is reported as an
// error: reading one needs OCR, which is a separate tool.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { toLino } from './evisa-sources.mjs';

/** Pulls the text out of a PDF, keeping the printed layout. */
export function pdfText(inputPath) {
  return execFileSync('pdftotext', ['-layout', inputPath, '-'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * The NA1a fields, each named by the label that precedes its value.
 *
 * The keys match the applicant schema the rest of the toolkit uses, so a form
 * read back here lines up with the record that filled it.
 */
const NA1A_FIELDS = [
  ['surname', /Surname:/],
  ['givenName', /Given name:/],
  ['dateOfBirth', /1\.3\.\s*Date of birth[^:]*:/],
  ['nationality', /1\.4\.\s*Nationality:/],
  ['placeOfBirth', /1\.5\.\s*Place of birth:/],
  ['religion', /1\.7\.\s*Religion:/],
  ['passportNumber', /3\.2\.\s*Passport number:/],
  ['passportIssueDate', /3\.4\.\s*Date of issue[^:]*:/],
  ['passportExpiryDate', /3\.5\.\s*Expiry date[^:]*:/],
  ['phone', /4\.3\.\s*Mobile phone[^:]*:/],
  ['email', /4\.4\.\s*Email address:/],
  ['emergencyName', /a\)\s*Full name:/],
  ['emergencyPhone', /c\)\s*Telephone number:/],
  ['emergencyRelation', /d\)\s*Relationship:/],
  ['durationOfStay', /6\.3\.\s*Intended duration of stay:/],
  ['entryDate', /6\.4\.\s*Intended date of entry[^:]*:/],
  ['exitGate', /6\.6\.\s*Intended border gate of exit:/],
];

/**
 * Fields whose value the form wraps onto the following line.
 *
 * The page is printed in two columns, so a long value continues underneath
 * its own label, and the label alone tells nothing about where it ends. Each
 * is read as the text between its own label and the next.
 */
const NA1A_SPANS = [
  ['issuingAuthority', /3\.3\.\s*Issuing Authority\/Place of issue:/],
  ['contactAddress', /4\.1\.\s*Contact address:/],
  ['homeAddress', /4\.2\.\s*Current residential address[^:]*:/],
  ['emergencyAddress', /b\)\s*Current residential address:/],
  ['entryGate', /6\.5\.\s*Intended border gate of entry:/],
  ['addressInVietnam', /6\.7\.\s*Residential address in Viet Nam:/],
];

/**
 * Anything that ends a value: the next label, or the boilerplate the form
 * prints between sections.
 */
const NEXT_LABEL =
  /(?:\d+\.\d+\.|[a-d]\)|Committed|Note:|If “|Yes\s+No)\s|[A-Z][A-Za-z /]{3,40}:/;

/**
 * A label that opens the second column of a line.
 *
 * The form numbers its fields, and that numbering is what separates a value
 * from the label beside it even when only one space stands between them.
 */
const NUMBERED_LABEL =
  /\s(?:\d+[.-]\d+\.\s*[A-Z][^:]*|[a-d]\)\s*[A-Z][^:]*|Given name|Surname):/;

/** Whether a page reads like the Vietnam e-visa application form. */
export function looksLikeNa1a(text) {
  return /VIET\s*NAM E-VISA APPLICATION FORM/i.test(text);
}

/**
 * Collapses the runs of spaces the layout uses to place columns.
 *
 * A value read out of a two-column line carries the gap that separated it
 * from its neighbour, and a value wrapped across lines carries the indent of
 * the line below.
 */
function tidy(value) {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .trim();
}

/**
 * Where a label sits and where its value starts, as column numbers.
 *
 * The form is printed in two columns, and `pdftotext -layout` keeps that
 * shape by padding with spaces. A label's own column is therefore the only
 * reliable way to tell its value from the neighbouring one.
 */
function locate(lines, label) {
  for (let row = 0; row < lines.length; row++) {
    const match = lines[row].match(label);
    if (match) {
      return { row, start: match.index, after: match.index + match[0].length };
    }
  }
  return null;
}

/**
 * The value a label introduces.
 *
 * It begins after the label and ends where the next label on that line
 * begins, which is what keeps the right-hand column out of the left-hand
 * value. A value too long for its column continues on the lines below at the
 * same indent, so those are taken as well, up to the width the first line
 * established.
 */
function valueAfter(lines, label, { wrap = false } = {}) {
  const at = locate(lines, label);
  if (!at) {
    return null;
  }
  const rest = lines[at.row].slice(at.after);
  // The neighbouring column begins at its own label, which may follow a wide
  // gap or, when the left value fills its column, a single space.
  const neighbour = rest.match(NUMBERED_LABEL);
  const head = neighbour ? rest.slice(0, neighbour.index) : rest;
  const parts = [head];
  const width = at.after + head.length;
  for (let row = at.row + 1; wrap && row < lines.length; row++) {
    const line = lines[row];
    if (!line.trim() || NEXT_LABEL.test(line.trimStart())) {
      break;
    }
    // A continuation is indented to its own column and stays inside the
    // width the label's line set; anything else belongs to another field.
    const indent = line.length - line.trimStart().length;
    if (indent < at.start - 2 || indent > width) {
      break;
    }
    parts.push(line.slice(0, width));
  }
  return tidy(parts.join(' ')) || null;
}

/** Reads a Vietnam e-visa application form into a record. */
export function parseNa1a(text) {
  const lines = text.split('\n');
  const record = {};
  for (const [key, label] of NA1A_FIELDS) {
    const value = valueAfter(lines, label);
    if (value) {
      record[key] = value;
    }
  }
  for (const [key, label] of NA1A_SPANS) {
    const value = valueAfter(lines, label, { wrap: true });
    if (value) {
      record[key] = value;
    }
  }
  // The date of request stands alone under its heading, with no label of its
  // own on the line.
  const requested = text.match(
    /DATE OF REQUEST[^\n]*\n\s*(\d{2}\/\d{2}\/\d{4})/
  );
  if (requested) {
    record.requestDate = requested[1];
  }
  const visaRange = text.match(
    /valid from \(dd\/mm\/yyyy\):\s*(\S+)\s*to:\s*(\S+)/
  );
  if (visaRange) {
    record.visaFrom = visaRange[1];
    record.visaTo = visaRange[2];
  }
  return record;
}

/** Reads every `Label: value` pair a page holds. */
export function parseLabelled(text) {
  const record = {};
  for (const line of text.split('\n')) {
    for (const part of line.split(/\s{3,}/)) {
      // A label may open with its section numbering, which `camelKey` drops.
      const match = part.match(
        /^\s*((?:[\d.-]+\s*)?[A-Za-z][A-Za-z0-9 .,/'()-]{2,60}?):\s+(.+?)\s*$/
      );
      if (!match) {
        continue;
      }
      const key = camelKey(match[1]);
      if (key && !record[key]) {
        record[key] = tidy(match[2]);
      }
    }
  }
  return record;
}

/** Turns a printed label into a key, dropping its section numbering. */
function camelKey(label) {
  const words = label
    .replace(/^[\d.]+\s*/, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .trim()
    .split(/\s+/);
  if (!words[0]) {
    return null;
  }
  return words
    .map((word, index) =>
      index === 0
        ? word.toLowerCase()
        : word[0].toUpperCase() + word.slice(1).toLowerCase()
    )
    .join('');
}

/**
 * Reads one PDF into a record.
 *
 * A PDF with no text in it is a scan, and saying so is more use than handing
 * back an empty record that looks like a form with nothing on it.
 */
export function readPdf(inputPath, { form = 'na1a' } = {}) {
  const text = pdfText(inputPath);
  if (!text.replace(/\s/g, '')) {
    throw new Error(
      `${inputPath} holds no text: it is a scan, and reading it needs OCR`
    );
  }
  const reading = form === 'auto' || !looksLikeNa1a(text) ? 'auto' : 'na1a';
  const record = reading === 'na1a' ? parseNa1a(text) : parseLabelled(text);
  return { record, reading };
}

/** Parses the flags above into a plain options object. */
export function parseArgs(argv) {
  const options = { inputs: [], form: 'na1a', json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--form') {
      options.form = argv[++i];
    } else if (arg === '--out' || arg === '-o') {
      options.out = argv[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (!arg.startsWith('-')) {
      options.inputs.push(arg);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.inputs.length) {
    console.error(
      'Usage: node src/pdf-to-lino.mjs <input.pdf> [...] [--form na1a|auto] [--out <dir>] [--json]'
    );
    process.exit(1);
  }
  if (options.out) {
    fs.mkdirSync(options.out, { recursive: true });
  }
  for (const input of options.inputs) {
    const { record, reading } = readPdf(input, { form: options.form });
    const text = options.json
      ? JSON.stringify(record, null, 2)
      : toLino(record);
    if (options.out) {
      const name = `${path.basename(input, path.extname(input))}.lino`;
      const target = path.join(options.out, name);
      fs.writeFileSync(target, `${text}\n`);
      console.log(
        `${target} (${reading}, ${Object.keys(record).length} fields)`
      );
    } else {
      if (options.inputs.length > 1) {
        console.log(`# ${input} (${reading})`);
      }
      console.log(text);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
