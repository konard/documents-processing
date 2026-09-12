// evisa-sources.mjs
//
// Loads applicant data from whatever the user happens to have: a JSON or lino
// file, a passport image or PDF, a previously issued Vietnam e-visa, a folder
// of all of the above, or a zip archive of one.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const JSON_EXT = new Set(['.json']);
const LINO_EXT = new Set(['.lino', '.links']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff']);
const PDF_EXT = new Set(['.pdf']);
const ARCHIVE_EXT = new Set(['.zip']);

/** Classifies a path by extension so the loader knows how to read it. */
export function classify(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (JSON_EXT.has(ext)) {
    return 'json';
  }
  if (LINO_EXT.has(ext)) {
    return 'lino';
  }
  if (IMAGE_EXT.has(ext)) {
    return 'image';
  }
  if (PDF_EXT.has(ext)) {
    return 'pdf';
  }
  if (ARCHIVE_EXT.has(ext)) {
    return 'archive';
  }
  return 'unknown';
}

/**
 * Maps the many spellings people use for the same field onto schema keys, so
 * hand-written JSON and third-party exports load without hand editing.
 */
const ALIASES = {
  last_name: 'surname',
  lastname: 'surname',
  family_name: 'surname',
  surname: 'surname',
  first_name: 'givenName',
  firstname: 'givenName',
  given_name: 'givenName',
  given_names: 'givenName',
  middle_and_given_name: 'givenName',
  dob: 'dateOfBirth',
  date_of_birth: 'dateOfBirth',
  birth_date: 'dateOfBirth',
  gender: 'sex',
  sex: 'sex',
  nationality: 'nationality',
  citizenship: 'nationality',
  passport: 'passportNumber',
  passport_no: 'passportNumber',
  passport_number: 'passportNumber',
  document_number: 'passportNumber',
  passport_expiry: 'passportExpiryDate',
  expiry: 'passportExpiryDate',
  expiry_date: 'passportExpiryDate',
  date_of_expiry: 'passportExpiryDate',
  passport_issue: 'passportIssueDate',
  issue_date: 'passportIssueDate',
  date_of_issue: 'passportIssueDate',
  place_of_birth: 'placeOfBirth',
  pob: 'placeOfBirth',
  email: 'email',
  phone: 'phone',
  telephone: 'phone',
};

const camel = (key) =>
  key.replace(/[_-]([a-z])/g, (_, c) => c.toUpperCase()).replace(/\s+/g, '');

/** Renames incoming keys to schema keys, leaving already-correct keys alone. */
export function applyAliases(record) {
  const out = {};
  for (const [rawKey, value] of Object.entries(record)) {
    // Keys starting with _ are comments in the input file. Keeping the prefix
    // marks them as comments, so they are not reported as unknown fields.
    if (rawKey.startsWith('_')) {
      out[rawKey] = value;
      continue;
    }
    const lower = rawKey.toLowerCase().replace(/\s+/g, '_');
    out[ALIASES[lower] ?? camel(rawKey)] = value;
  }
  return out;
}

/**
 * Reads lino notation. The optional `lino-objects-codec` dependency is used
 * when present; otherwise a small parser handles the `(key "value")` subset
 * this tool emits, so lino input works without an extra install.
 */
export async function parseLino(text) {
  try {
    const codec = await import('lino-objects-codec');
    return codec.decode({ notation: text });
  } catch {
    return parseLinoFallback(text);
  }
}

/** Minimal reader for flat `key "value"` lino documents. */
export function parseLinoFallback(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '(' || trimmed === ')') {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z_][\w-]*)\s+(.*)$/);
    if (!match) {
      continue;
    }
    let value = match[2]
      .trim()
      .replace(/^\(|\)$/g, '')
      .trim();
    if (/^".*"$/.test(value)) {
      value = value.slice(1, -1);
    }
    if (value === 'true' || value === 'false') {
      out[match[1]] = value === 'true';
      continue;
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * Serializes a record as single-line-per-field lino notation. Comment keys are
 * left out, so the result is a clean record ready to feed back in.
 */
export function toLino(record) {
  const lines = ['('];
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('_')) {
      continue;
    }
    const text =
      typeof value === 'boolean' || typeof value === 'number'
        ? String(value)
        : `"${String(value).replace(/"/g, '\\"')}"`;
    lines.push(`  ${key} ${text}`);
  }
  lines.push(')');
  return lines.join('\n');
}

/** Expands a zip into a temporary directory and returns that path. */
export function extractArchive(archivePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-archive-'));
  execFileSync('unzip', ['-qq', '-o', archivePath, '-d', dir]);
  // The documents inside are used for as long as the run lasts, and hold
  // personal data, so the directory goes when the process does.
  process.once('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });
  return dir;
}

/** Lists files in a directory tree, skipping dotfiles and resource forks. */
export function walk(dir, depth = 0) {
  if (depth > 6) {
    return [];
  }
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__MACOSX') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, depth + 1));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * Loads one source path into `{ name, data }` records. Images and PDFs are
 * returned as document references; OCR is expensive, so the caller decides
 * whether to run it.
 */
export async function loadSource(sourcePath) {
  const kind = classify(sourcePath);
  const name = path.basename(sourcePath);

  if (kind === 'json') {
    const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    const record = parsed.applicant ?? parsed;
    return [{ name, kind, data: applyAliases(record) }];
  }

  if (kind === 'lino') {
    const parsed = await parseLino(fs.readFileSync(sourcePath, 'utf8'));
    return [{ name, kind, data: applyAliases(parsed) }];
  }

  if (kind === 'image' || kind === 'pdf') {
    return [{ name, kind, data: {}, documentPath: sourcePath }];
  }

  if (kind === 'archive') {
    const dir = extractArchive(sourcePath);
    return loadDirectory(dir);
  }

  if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory()) {
    return loadDirectory(sourcePath);
  }

  return [];
}

/** Loads every recognized file in a directory tree. */
export async function loadDirectory(dir) {
  const out = [];
  for (const file of walk(dir)) {
    if (classify(file) === 'unknown') {
      continue;
    }
    out.push(...(await loadSource(file)));
  }
  return out;
}

/**
 * Guesses what a document is from its filename, so a folder of mixed scans is
 * routed correctly: portraits to the photo upload, data pages to OCR.
 */
export function guessDocumentRole(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (/photo|portrait|headshot/.test(base) && !/passport/.test(base)) {
    return 'portrait';
  }
  if (/passport/.test(base)) {
    return 'passport';
  }
  if (/visa/.test(base)) {
    return 'visa';
  }
  return 'unknown';
}
