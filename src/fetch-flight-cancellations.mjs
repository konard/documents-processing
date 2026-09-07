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
// Usage:  node fetch-flight-cancellations.mjs [baseDir] [--source=api|browser]
//           [--days=90] [--airlines=indigo,"air india"] [--keywords=cancel,refund]
//           [--exclude=redditmail.com,term] [--query="<full raw Gmail query>"]
//           [--out=<dir>] [--limit=N] [--refresh]
//
// Browser source is two-phase and curated: it first lists message metadata
// (no messages opened), auto-selects the ones that look like genuine flight
// cancellation / change / refund originals (airline/agent sender + matching
// subject) and drops noise (social mail, promos, mail you sent yourself), then
// fetches only the chosen ones. A MANIFEST.txt records chosen vs skipped.
//   --list           list metadata + write the manifest, fetch nothing
//   --select=<ids>   fetch exactly these thread ids (comma-separated), instead
//                    of the auto-curation
// Set USER_EMAILS=you@example.com (env/.env) so mail from yourself is skipped.

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
import { listMetadata, searchAndExtract } from './gmail-browser-search.mjs';
import { curate } from './flight-relevance.mjs';

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

// Default exclusions keep obvious non-flight noise out (social mail, and mail
// you sent yourself); --exclude=a,b appends more (domains → -from:, else -term).
const DEFAULT_EXCLUDE = ['redditmail.com', 'reddit.com'];
const query =
  flags.query ||
  buildQuery({
    days: flags.days ? Number(flags.days) : 90,
    airlines: flags.airlines ? splitList(flags.airlines) : undefined,
    keywords: flags.keywords ? splitList(flags.keywords) : undefined,
    exclude: [
      ...DEFAULT_EXCLUDE,
      ...(flags.exclude ? splitList(flags.exclude) : []),
    ],
  });

function splitList(value) {
  // A flag given without a value arrives as `true`; that is an empty list.
  if (typeof value !== 'string') {
    return [];
  }
  // Split on commas not inside quotes; strip surrounding quotes.
  return (value.match(/("[^"]*"|[^,]+)/g) ?? [])
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

// RFC Message-IDs already present in OUT_DIR, so the SAME message is never saved
// twice — even when it arrives in two different byte forms (e.g. a raw MIME copy
// from the Gmail API and an HTML copy rendered from the Gmail DOM by the browser
// path). Those differ byte-for-byte, so a content hash gives them different
// names and the old "does the file exist?" check missed the duplicate. The
// Message-ID header is identical across both, so we key de-duplication on it.
// Built once, lazily, by scanning the existing .eml files' headers.
let seenMessageIds = null;
function messageIdOf(eml) {
  // Read only the header block; the Message-ID line is case-insensitive.
  const headerEnd = eml.indexOf('\r\n\r\n');
  const header = (
    headerEnd === -1 ? eml.slice(0, 8192) : eml.slice(0, headerEnd)
  ).toString('utf8');
  const match = header.match(/^message-id:\s*(.+)$/im);
  return match ? match[1].trim() : null;
}
function loadSeenMessageIds() {
  const ids = new Set();
  if (!fs.existsSync(OUT_DIR)) {
    return ids;
  }
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (!name.endsWith('.eml')) {
      continue;
    }
    const id = messageIdOf(fs.readFileSync(path.join(OUT_DIR, name)));
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

// True if this message is already on disk — by RFC Message-ID (survives the
// browser-vs-API byte differences) or by its content-hash filename. Logs the
// reason and returns true so the caller can skip it. Honours --refresh.
function alreadySaved(eml, messageId, base, index, total) {
  if (flags.refresh) {
    return false;
  }
  if (seenMessageIds === null) {
    seenMessageIds = loadSeenMessageIds();
  }
  if (messageId && seenMessageIds.has(messageId)) {
    console.log(`• [${index}/${total}] ${base} — duplicate message, skipped`);
    return true;
  }
  if (fs.existsSync(path.join(OUT_DIR, `${base}.eml`))) {
    console.log(`• [${index}/${total}] ${base} — already saved, skipped`);
    return true;
  }
  return false;
}

// Save one email: its .eml original, a PDF per working engine, and any real
// attachments — all named from the message content. Shared by both sources.
// Idempotent: skips the message if one with the same RFC Message-ID (or the same
// content-hash filename) is already saved, so a resumed run — or the other
// source seeing the same mail — does no duplicate work.
async function saveEmail(eml, index, total) {
  const parsedForName = await simpleParser(eml);
  const base = baseName(parsedForName, eml);
  const messageId = messageIdOf(eml);

  if (alreadySaved(eml, messageId, base, index, total)) {
    return;
  }

  const { parsed, results } = await emlToPdfs(
    eml,
    path.join(OUT_DIR, 'tmp'),
    DATA_DIR
  );

  fs.writeFileSync(path.join(OUT_DIR, `${base}.eml`), eml);
  if (messageId) {
    // Track it so a later duplicate in the same run is skipped. The set may be
    // unset here when --refresh short-circuited alreadySaved(), so seed it.
    seenMessageIds ??= loadSeenMessageIds();
    seenMessageIds.add(messageId);
  }

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

// Print and persist the curation decision so it is auditable.
function reportCuration(chosen, skipped) {
  const line = (entry) =>
    `  ${entry.threadId}  ${entry.from || '?'}  |  ${(entry.subject || '').slice(0, 60)}  [${entry.reasons.join('; ')}]`;
  const manifest = [
    `Query: ${query}`,
    '',
    `CHOSEN (${chosen.length}) — flight-cancellation originals:`,
    ...chosen.map(line),
    '',
    `SKIPPED (${skipped.length}) — not flight-cancellation:`,
    ...skipped.map(line),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'MANIFEST.txt'), manifest);
  console.log(manifest);
}

// Browser source: list metadata, curate for FRRO relevance (or honor an
// explicit --select), then fetch only the chosen messages in full.
async function runBrowserSource() {
  const strategy = flags.strategy || 'cookies';
  const cacheDir = path.join(DATA_DIR, 'flight-cancellations-cache');
  const selfAddresses = (process.env.USER_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  console.log('Listing message metadata (no messages opened yet)…\n');
  const rows = await listMetadata({ dataDir: DATA_DIR, query, strategy });
  console.log(`Found ${rows.length} message(s).\n`);

  // Decide which threads to fetch: an explicit --select wins; otherwise curate.
  let chosen;
  let skipped = [];
  if (flags.select) {
    const wanted = new Set(splitList(String(flags.select)));
    chosen = rows.filter((row) => wanted.has(row.threadId));
    skipped = rows.filter((row) => !wanted.has(row.threadId));
    chosen.forEach((row) => (row.reasons = ['manually selected']));
    skipped.forEach((row) => (row.reasons = ['not selected']));
  } else {
    ({ chosen, skipped } = curate(rows, selfAddresses));
  }

  reportCuration(chosen, skipped);

  if (flags.list) {
    console.log('\n--list: metadata + manifest written; nothing fetched.');
    return;
  }
  if (chosen.length === 0) {
    console.log('No flight-cancellation messages to fetch.');
    return;
  }

  const messages = await searchAndExtract({
    dataDir: DATA_DIR,
    query,
    strategy,
    cacheDir,
    refresh: flags.refresh === true,
    threadIds: chosen.map((row) => row.threadId),
    onProgress: (event) => {
      if (event.phase === 'listed') {
        console.log(`\nFetching ${event.total} chosen message(s)…\n`);
      } else if (event.phase === 'backoff') {
        console.log('  … rate-limited by Gmail; backing off 15s and retrying');
      }
    },
  });

  let index = 0;
  for (const message of messages) {
    index += 1;
    await saveEmail(message.eml, index, messages.length);
  }
  console.log(`\nDone. Saved ${messages.length} email(s) to:\n  ${OUT_DIR}`);
}

// ---- main -----------------------------------------------------------------

const source = flags.source || 'api';
console.log(`Source: ${source}\nGmail query: ${query}\n`);
fs.mkdirSync(OUT_DIR, { recursive: true });

if (source === 'browser') {
  await runBrowserSource();
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
