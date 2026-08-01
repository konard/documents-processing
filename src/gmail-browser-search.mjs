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

// Collect each result row's metadata WITHOUT opening the message: the stable
// thread id, sender (name + email), subject, and the listed date — read
// straight from the list row, top to bottom.
async function collectResultRows(page) {
  // The callback runs in the browser page context.
  return await page.locator('tr.zA').evaluateAll((rows) => {
    const attr = (element, name) => element?.getAttribute(name) || '';
    const text = (element) => element?.textContent?.trim() || '';
    return rows
      .map((row) => {
        const threadId = attr(
          row.querySelector('[data-legacy-thread-id]'),
          'data-legacy-thread-id'
        );
        if (!threadId) {
          return null;
        }
        const sender = row.querySelector('.yW span[email], .yX span[email]');
        const dateNode = row.querySelector('.xW span[title], td.xW span');
        return {
          threadId,
          subject: text(row.querySelector('.bog')),
          fromEmail: attr(sender, 'email'),
          fromName: attr(sender, 'name'),
          dateText: attr(dateNode, 'title') || text(dateNode),
        };
      })
      .filter(Boolean);
  });
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

  // Open the thread by changing only the URL hash. A full goto() would hang
  // (a fragment change fires no document load), so set location.hash directly
  // and then wait for the message body to render. Gmail can lag on the first
  // open, so re-open and re-read once if the body comes back empty.
  const threadHash = `#search/${encodeURIComponent(query)}/${threadId}`;
  let fields = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Runs in the browser page context, where globalThis is the window. On the
    // retry, bounce via the list first so the hash change definitely re-renders.
    if (attempt === 1) {
      await page.evaluate(
        (hash) => {
          globalThis.location.hash = hash;
        },
        `#search/${encodeURIComponent(query)}`
      );
      await wait(1200);
    }
    await page.evaluate((hash) => {
      globalThis.location.hash = hash;
    }, threadHash);

    if (await looksRateLimited(page)) {
      return { rateLimited: true };
    }

    await page
      .locator('.a3s')
      .first()
      .waitFor({ state: 'visible', timeout: 20000 })
      .catch(() => {});
    await wait(800);

    fields = await readOpenMessage(page);
    if (fields.bodyHtml && fields.bodyHtml.length > 0) {
      break; // got the body; no retry needed
    }
  }

  const eml = Buffer.from(synthesizeEml(fields), 'utf8');
  // Only cache a real extraction, so an empty first-open isn't cached as final.
  if (cacheFile && fields.bodyHtml && fields.bodyHtml.length > 0) {
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
  await page.goto(searchUrl(query), { waitUntil: 'commit' }).catch(() => {});
  // Wait for the result rows to render (JS-driven), not a fixed sleep.
  await page
    .locator('tr.zA')
    .first()
    .waitFor({ state: 'visible', timeout: 30000 })
    .catch(() => {});
  return collectResultRows(page);
}

// Phase 1: list result metadata (threadId, sender, subject, date) WITHOUT
// opening any message — cheap and gentle on rate limits. Returns the rows so a
// caller can decide which to fetch in full.
// options: { dataDir, query, strategy }
export async function listMetadata(options = {}) {
  const { dataDir, query, strategy = 'cookies' } = options;
  const { browser, page } = await openGmail({
    dataDir,
    strategy,
    headless: true,
  });
  try {
    return await runSearch(page, query);
  } finally {
    await browser.close().catch(() => {});
  }
}

// Phase 2 (or one-shot): search Gmail and yield one synthesized .eml (Buffer)
// per matching message. Pass options.threadIds to fetch only those threads
// (the curated selection from listMetadata); omit it to fetch everything.
// options: { dataDir, query, limit, strategy, cacheDir, refresh, threadIds,
//            onProgress }
export async function searchAndExtract(options = {}) {
  const {
    dataDir,
    query,
    limit = 0,
    strategy = 'cookies',
    cacheDir,
    refresh = false,
    threadIds = null,
    onProgress = () => {},
  } = options;
  const allowed = threadIds ? new Set(threadIds) : null;
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
    const filtered = allowed
      ? rows.filter((row) => allowed.has(row.threadId))
      : rows;
    const selected = limit > 0 ? filtered.slice(0, limit) : filtered;
    onProgress({ phase: 'listed', total: selected.length });

    for (let index = 0; index < selected.length; index += 1) {
      const outcome = await processOneRow({
        page,
        query,
        row: selected[index],
        index,
        cacheDir,
        refresh,
        onProgress,
      });
      if (outcome.retry) {
        index -= 1; // backed off; retry this row once
      } else if (outcome.message) {
        messages.push(outcome.message);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return messages;
}

// Fetch one selected row (honoring cache + backoff + pacing) and report
// progress. Returns { message } on success, or { retry: true } after a backoff.
async function processOneRow(context) {
  const { page, query, row, index, cacheDir, refresh, onProgress } = context;
  const cacheFile = cacheDir ? messageCachePath(cacheDir, row.threadId) : null;
  const result = await fetchOneThread(
    page,
    query,
    row.threadId,
    cacheFile,
    refresh
  );

  if (result.rateLimited) {
    onProgress({ phase: 'backoff', index });
    await wait(15000); // Google asked us to slow down — back off hard.
    return { retry: true };
  }

  const subject = result.fields?.subject || row.subject;
  onProgress({
    phase: result.cached ? 'cached' : 'extracted',
    index,
    subject,
  });
  // Respect rate limits: pace only real fetches (cache hits are free).
  if (!result.cached) {
    await wait(pacedDelay(index));
  }
  return { message: { eml: result.eml, threadId: row.threadId, subject } };
}
