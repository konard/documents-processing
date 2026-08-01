// gmail-browser-search.mjs — search Gmail and extract each matching message
// through the logged-in browser session (built on gmail-browser.mjs).
//
// This is the DOM-based counterpart to the Gmail API path. It drives the normal
// Gmail web UI: run a search, walk the result rows, open each message, and read
// its rendered fields (sender, subject, date, HTML body). No raw MIME is
// available this way, so a minimal RFC-822 .eml is synthesized from the fields
// for the downstream PDF renderers.
//
// Rate limits are respected deliberately: messages are processed strictly
// sequentially with a randomized delay between opens, and there is no parallel
// fan-out. Google's own error pages (e.g. a temporary 404) are detected and
// treated as a signal to back off.
//
// Each extracted message is cached to disk keyed by its stable thread id, so a
// re-run after a crash skips messages already fetched (fewer requests, faster
// resume). Pass cacheDir to enable; the cache lives under data/ (git-ignored).

import fs from 'node:fs';
import path from 'node:path';
import { openGmail, isLoggedIn } from './gmail-browser.mjs';

// A visible "temporary error" page from Google means we are going too fast.
const RATE_LIMIT_MARKERS = [
  'Temporary Error',
  'temporarily unavailable',
  'unusual traffic',
];

// Sequential pacing (ms) between opening messages; jittered so it is not robotic.
const MIN_DELAY_MS = 1500;
const MAX_DELAY_MS = 3500;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A deterministic-but-varied delay: seeded by the message index so runs are
// reproducible without Math.random (which some sandboxes disallow).
function pacedDelay(index) {
  const span = MAX_DELAY_MS - MIN_DELAY_MS;
  const jitter = (Math.sin(index * 12.9898) * 43758.5453) % 1;
  return MIN_DELAY_MS + Math.floor(Math.abs(jitter) * span);
}

async function looksRateLimited(page) {
  const text = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  return RATE_LIMIT_MARKERS.some((marker) => text.includes(marker));
}

// Build the Gmail web search hash URL for a raw query string.
function searchUrl(query) {
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
}

// Collect the result rows' stable thread ids (from the child element that
// carries data-legacy-thread-id) plus the listed subject, top to bottom.
async function collectResultRows(page) {
  return await page.locator('tr.zA').evaluateAll((rows) =>
    rows
      .map((row) => {
        const idNode = row.querySelector('[data-legacy-thread-id]');
        const threadId = idNode?.getAttribute('data-legacy-thread-id') || null;
        const subject = row.querySelector('.bog')?.textContent?.trim() || '';
        return threadId ? { threadId, subject } : null;
      })
      .filter(Boolean)
  );
}

// Read the currently-open message's fields from the Gmail DOM.
async function readOpenMessage(page) {
  const from = await page
    .locator('.gD')
    .first()
    .getAttribute('email')
    .catch(() => null);
  const fromName = await page
    .locator('.gD')
    .first()
    .getAttribute('name')
    .catch(() => null);
  const subject = await page
    .locator('h2.hP')
    .first()
    .innerText()
    .catch(() => '');
  // The visible send date sits in a title/attribute on the header row.
  const dateText = await page
    .locator('.g3')
    .first()
    .getAttribute('title')
    .catch(() => null);
  // The message body container; take its inner HTML to keep formatting.
  const bodyHtml = await page
    .locator('.a3s')
    .first()
    .innerHTML()
    .catch(() => '');
  return { from, fromName, subject, dateText, bodyHtml };
}

// Synthesize a minimal RFC-822 message so mailparser (in eml-to-pdf) can read
// it. Only fields we actually extracted are included.
export function synthesizeEml({ from, fromName, subject, dateText, bodyHtml }) {
  const fromHeader = fromName ? `${fromName} <${from}>` : from || 'unknown';
  const headers = [
    `From: ${fromHeader}`,
    subject ? `Subject: ${subject}` : null,
    dateText ? `Date: ${dateText}` : null,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
  ].filter(Boolean);
  return `${headers.join('\r\n')}\r\n\r\n${bodyHtml || ''}`;
}

// Per-thread .eml cache, so a re-run resumes without re-fetching. Keyed by the
// stable thread id.
function messageCachePath(cacheDir, threadId) {
  return path.join(cacheDir, `${threadId}.eml`);
}

// Open one thread and extract its synthesized .eml, honoring the resume cache
// and a rate-limit backoff. Returns { eml, fields } on success, or
// { rateLimited: true } when Google served an error page (caller retries).
async function fetchOneThread(page, query, threadId, cacheFile, refresh) {
  if (cacheFile && !refresh && fs.existsSync(cacheFile)) {
    return { eml: fs.readFileSync(cacheFile), cached: true };
  }

  await page.goto(`${searchUrl(query)}/${threadId}`, {
    waitUntil: 'domcontentloaded',
  });
  if (await looksRateLimited(page)) {
    return { rateLimited: true };
  }

  // Wait for the message body to actually render (Gmail loads it via JS, so a
  // fixed sleep is unreliable); a short pause covers the timeout case.
  await page
    .locator('.a3s')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 })
    .catch(() => {});
  await wait(500);

  const fields = await readOpenMessage(page);
  const eml = Buffer.from(synthesizeEml(fields), 'utf8');
  if (cacheFile) {
    fs.writeFileSync(cacheFile, eml);
  }
  return { eml, fields };
}

// Verify the session is logged in, run the search, and return the result rows.
async function runSearch(page, query) {
  if (!(await isLoggedIn(page))) {
    throw new Error(
      'Not logged in to Gmail in the browser session. Run once with a visible ' +
        'window (strategy "profile") to sign in, or refresh the cookie cache.'
    );
  }
  await page.goto(searchUrl(query), { waitUntil: 'domcontentloaded' });
  // Wait for the result rows to render (JS-driven), not a fixed sleep.
  await page
    .locator('tr.zA')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 })
    .catch(() => {});
  return collectResultRows(page);
}

// Search Gmail and yield one synthesized .eml (Buffer) per matching message.
// options: { dataDir, query, limit, strategy, cacheDir, refresh, onProgress }
export async function searchAndExtract(options = {}) {
  const {
    dataDir,
    query,
    limit = 0,
    strategy = 'cookies',
    cacheDir,
    refresh = false,
    onProgress = () => {},
  } = options;
  if (cacheDir) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const { browser, page } = await openGmail({
    dataDir,
    strategy,
    headless: true,
  });
  const messages = [];
  try {
    const rows = await runSearch(page, query);
    const selected = limit > 0 ? rows.slice(0, limit) : rows;
    onProgress({ phase: 'listed', total: selected.length });

    for (let index = 0; index < selected.length; index += 1) {
      const { threadId, subject } = selected[index];
      const cacheFile = cacheDir ? messageCachePath(cacheDir, threadId) : null;
      const result = await fetchOneThread(
        page,
        query,
        threadId,
        cacheFile,
        refresh
      );

      if (result.rateLimited) {
        onProgress({ phase: 'backoff', index });
        await wait(15000); // Google asked us to slow down — back off hard.
        index -= 1; // retry this message once after backing off
        continue;
      }

      const finalSubject = result.fields?.subject || subject;
      messages.push({ eml: result.eml, threadId, subject: finalSubject });
      onProgress({
        phase: result.cached ? 'cached' : 'extracted',
        index,
        subject: finalSubject,
      });

      // Respect rate limits: pace only real fetches (cache hits are free).
      if (!result.cached) {
        await wait(pacedDelay(index));
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return messages;
}
