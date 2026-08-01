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
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  makeGmailClient,
  buildQuery,
  listMessageIds,
  fetchRawEml,
} from './gmail-lib.mjs';
import { simpleParser } from 'mailparser';
import { emlToPdfs } from './eml-to-pdf.mjs';
import { searchAndExtract } from './gmail-browser-search.mjs';

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

// A short, content-derived suffix so the same message always maps to the same
// filename (letting a resume detect and skip already-written output).
function shortHash(buffer) {
  return createHash('sha1').update(buffer).digest('hex').slice(0, 8);
}

function baseName(parsed, eml) {
  const from = sanitize(
    parsed.from?.value?.[0]?.address || parsed.from?.text,
    40
  );
  const subject = sanitize(parsed.subject, 60);
  return `${dateStamp(parsed.date)}-${from}-${subject}-${shortHash(eml)}`;
}

// Save one email: its .eml original, a PDF per working engine, and any real
// attachments — all named from the message content. Shared by both sources.
// Idempotent: if the .eml for this message already exists (same content hash),
// the whole email is skipped so a resumed run does no duplicate work.
async function saveEmail(eml, index, total) {
  const parsedForName = await simpleParser(eml);
  const base = baseName(parsedForName, eml);

  if (fs.existsSync(path.join(OUT_DIR, `${base}.eml`)) && !flags.refresh) {
    console.log(`• [${index}/${total}] ${base} — already saved, skipped`);
    return;
  }

  const { parsed, results } = await emlToPdfs(
    eml,
    path.join(OUT_DIR, 'tmp'),
    DATA_DIR
  );

  fs.writeFileSync(path.join(OUT_DIR, `${base}.eml`), eml);

  const madePdfs = [];
  for (const result of results) {
    if (result.path && fs.existsSync(result.path)) {
      fs.renameSync(
        result.path,
        path.join(OUT_DIR, `${base}-${result.engine}.pdf`)
      );
      madePdfs.push(result.engine);
    }
  }

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
    `✓ [${index}/${total}] ${base}\n` +
      `    PDF engines ok: ${madePdfs.join(', ') || '(none)'}${
        failed.length ? `  | failed: ${failed.join(' ; ')}` : ''
      }\n    .eml + ${attachmentCount} attachment(s)`
  );
}

// ---- main -----------------------------------------------------------------

const source = flags.source || 'api';
console.log(`Source: ${source}\nGmail query: ${query}\n`);
fs.mkdirSync(OUT_DIR, { recursive: true });

if (source === 'browser') {
  // Browser path: reuse the logged-in Chrome session (no OAuth client needed).
  // searchAndExtract paces itself to respect Gmail's rate limits.
  const messages = await searchAndExtract({
    dataDir: DATA_DIR,
    query,
    limit: flags.limit ? Number(flags.limit) : 0,
    strategy: flags.strategy || 'cookies',
    cacheDir: path.join(DATA_DIR, 'flight-cancellations-cache'),
    refresh: flags.refresh === true,
    onProgress: (event) => {
      if (event.phase === 'listed') {
        console.log(`Matched ${event.total} message(s) via browser.\n`);
      } else if (event.phase === 'cached') {
        console.log(`  (resume) reused cached message #${event.index + 1}`);
      } else if (event.phase === 'backoff') {
        console.log('  … rate-limited by Gmail; backing off 15s and retrying');
      }
    },
  });
  if (messages.length === 0) {
    console.log('Nothing to do.');
    process.exit(0);
  }
  let index = 0;
  for (const message of messages) {
    index += 1;
    await saveEmail(message.eml, index, messages.length);
  }
  console.log(`\nDone. Saved ${messages.length} email(s) to:\n  ${OUT_DIR}`);
} else {
  // API path: Gmail API with an OAuth client; downloads the byte-exact raw MIME.
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
  let index = 0;
  for (const id of limited) {
    index += 1;
    const eml = await fetchRawEml(gmail, id);
    await saveEmail(eml, index, limited.length);
  }
  console.log(`\nDone. Saved ${limited.length} email(s) to:\n  ${OUT_DIR}`);
}
