#!/usr/bin/env node
// fetch-flight-cancellations.mjs
//
// Collects flight-cancellation emails (including back-and-forth with the
// airlines) from Gmail and saves each one as its original, in
// flight-cancellations-originals/ next to the other documents.
//
// Scope is kept tight by default so unrelated mail is never processed:
//   - only the two airlines: IndiGo and Air India
//   - only cancellation-related mail: cancel / cancellation / refund / reschedule
//   - only the last 90 days
// Each part is overridable via flags (see below).
//
// For every matching email it writes, using content-derived names:
//   <date>-<from>-<subject>.eml                 — byte-exact RFC-2822 original
//   <date>-<from>-<subject>-<engine>.pdf        — one PDF per working engine
//   <date>-<from>-<subject>-attachment-N-<name> — each real attachment
//
// PDFs are produced by several independent engines (system Chrome, optional
// browser-commander, optional wkhtmltopdf, and a pure pdf-lib fallback); all
// that succeed are kept, so a single engine failing never loses an email.
//
// No personal data is stored in code: OAuth credentials and token live in the
// environment / .env / data/ (git-ignored). See gmail-lib.mjs.
//
// Usage:  node fetch-flight-cancellations.mjs [baseDir] [--days=90]
//           [--airlines=indigo,"air india"] [--keywords=cancel,refund]
//           [--query="<full raw Gmail query>"] [--out=<dir>] [--limit=N]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeGmailClient,
  buildQuery,
  listMessageIds,
  fetchRawEml,
} from './gmail-lib.mjs';
import { emlToPdfs } from './eml-to-pdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- args -----------------------------------------------------------------

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const flags = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const eq = arg.indexOf('=');
      return eq === -1
        ? [arg.slice(2), true]
        : [arg.slice(2, eq), arg.slice(eq + 1)];
    })
);

// Scripts live in src/; document folders live one level up in the project root.
const BASE = positional[0] || path.dirname(__dirname);
const OUT_DIR = flags.out
  ? path.resolve(flags.out)
  : path.join(BASE, 'flight-cancellations-originals');
const DATA_DIR = path.join(BASE, 'data');

const query =
  flags.query ||
  buildQuery({
    days: flags.days ? Number(flags.days) : 90,
    airlines: flags.airlines ? splitList(flags.airlines) : undefined,
    keywords: flags.keywords ? splitList(flags.keywords) : undefined,
  });

function splitList(value) {
  // Split on commas not inside quotes; strip surrounding quotes.
  return value
    .match(/("[^"]*"|[^,]+)/g)
    .map((token) => token.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

// ---- naming (from content, sanitized) -------------------------------------

const sanitize = (text, max = 60) =>
  String(text || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/\s/g, '_') || 'untitled';

// yyyy-mm-dd from the message date, or a stable placeholder when it is absent.
function dateStamp(parsedDate) {
  if (!parsedDate) {
    return 'undated';
  }
  return parsedDate.toISOString().slice(0, 10);
}

function baseName(parsed, index) {
  const from = sanitize(
    parsed.from?.value?.[0]?.address || parsed.from?.text,
    40
  );
  const subject = sanitize(parsed.subject, 60);
  return `${dateStamp(parsed.date)}-${from}-${subject}-${String(index).padStart(3, '0')}`;
}

// ---- main -----------------------------------------------------------------

console.log(`Gmail query: ${query}\n`);

const gmail = await makeGmailClient(BASE);
const ids = await listMessageIds(gmail, query);
const limited = flags.limit ? ids.slice(0, Number(flags.limit)) : ids;
console.log(
  `Matched ${ids.length} message(s); processing ${limited.length}.\n`
);

if (limited.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

let index = 0;
for (const id of limited) {
  index += 1;
  const eml = await fetchRawEml(gmail, id);
  const { parsed, results } = await emlToPdfs(
    eml,
    path.join(OUT_DIR, 'tmp'),
    DATA_DIR
  );

  const base = baseName(parsed, index);

  // 1) original .eml
  const emlPath = path.join(OUT_DIR, `${base}.eml`);
  fs.writeFileSync(emlPath, eml);

  // 2) rename each engine's PDF to the content-derived base name
  const madePdfs = [];
  for (const result of results) {
    if (result.path && fs.existsSync(result.path)) {
      const finalPath = path.join(OUT_DIR, `${base}-${result.engine}.pdf`);
      fs.renameSync(result.path, finalPath);
      madePdfs.push(result.engine);
    }
  }

  // 3) real attachments (skip inline cid images already embedded in the PDF)
  let attachmentCount = 0;
  for (const attachment of parsed.attachments || []) {
    if (attachment.related) {
      continue; // inline image, already inside the rendered PDF
    }
    attachmentCount += 1;
    const name = sanitize(attachment.filename || `file-${attachmentCount}`, 60);
    fs.writeFileSync(
      path.join(OUT_DIR, `${base}-attachment-${attachmentCount}-${name}`),
      attachment.content
    );
  }

  const failed = results
    .filter((result) => result.error)
    .map((result) => `${result.engine}:${result.error}`);
  console.log(
    `✓ [${index}/${limited.length}] ${base}\n` +
      `    PDF engines ok: ${madePdfs.join(', ') || '(none)'}${
        failed.length ? `  | failed: ${failed.join(' ; ')}` : ''
      }\n    .eml + ${attachmentCount} attachment(s)`
  );
}

console.log(`\nDone. Saved ${limited.length} email(s) to:\n  ${OUT_DIR}`);
