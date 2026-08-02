// gmail-browser.mjs — read Gmail through a real browser via browser-commander,
// reusing an existing logged-in Google session (an alternative to the API).
//
// This is an alternative to gmail-lib.mjs (Gmail API) for when you would rather
// not set up an OAuth client: you log in to Google once in the automated
// browser, and the session is reused thereafter.
//
// Built on link-foundation/browser-commander. Where browser-commander does not
// yet wrap a capability we need, we fall back to the raw Playwright `page` (its
// README explicitly recommends this) and have filed a tracking request for each
// gap (numbers are link-foundation/browser-commander issues):
//   - system Chrome via channel/executablePath ....... bc-57
//   - storageState to reuse a saved session .......... bc-58
//   - content extraction (content/innerText/evaluate)  bc-59
//   - setContent to load an in-memory HTML string .... bc-60
//   - connect to a running real browser over CDP ..... bc-66
//   - drive the real installed browser, authenticated  bc-68
//   - import cookies from an installed browser ........ bc-69
//   - automation-friendly launch defaults (no prompts)  bc-70
// As those land, the corresponding workaround here can be removed.
//
// Session strategies (choose via the `strategy` option):
//   'cookies' — read and decrypt the Google cookies from the local Chrome
//               profile (via chrome-cookies.mjs) and inject them, so an existing
//               Chrome login is reused with no re-login. Needs Keychain consent.
//   'profile' — a dedicated persistent userDataDir (default). First run: you log
//               in once in the opened window; the session persists for reuse.
//   'state'   — load a saved Playwright storageState JSON (portable session).
//
// No secrets are stored in this file; any saved session lives under data/
// (git-ignored).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readChromeCookies } from './chrome-cookies.mjs';

// browser-commander is an optional dependency; import lazily so the rest of the
// toolkit works without it installed.
async function loadBrowserCommander() {
  try {
    return await import('browser-commander');
  } catch {
    throw new Error(
      'browser-commander is not installed. Install the browser extra:\n' +
        '  npm install browser-commander playwright && npx playwright install chromium'
    );
  }
}

// ---- connect to the real, installed browser over CDP ----------------------
//
// Some Google surfaces (e.g. Google Cloud Console) refuse to sign in from a
// Playwright-launched Chromium — Google flags it "This browser or app may not
// be secure" and rejects the session, even with valid injected cookies. The
// clean workaround is to attach to the user's ACTUAL Chrome (already signed in)
// via the DevTools protocol, so Google sees a genuine browser.
//
// This capability is missing from browser-commander (its launchBrowser neither
// takes executablePath/channel for the system browser nor a connect/CDP
// endpoint for a running one). Filed as bc-66 (connectBrowser over CDP) and
// bc-68 (drive the real installed browser, authenticated — genuine browser +
// dedicated profile + cookie seeding, the combination validated here). Until
// they land, we drive the raw Playwright `connectOverCDP` here.

const SYSTEM_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

function findSystemChrome() {
  return (
    SYSTEM_CHROME_PATHS.find((candidate) => fs.existsSync(candidate)) || null
  );
}

// Poll the DevTools JSON endpoint until the debugging port is answering.
function waitForDebugPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(
        { host: '127.0.0.1', port, path: '/json/version' },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch (error) {
              reject(error);
            }
          });
        }
      );
      request.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('Chrome debug port did not open in time'));
        } else {
          setTimeout(attempt, 400);
        }
      });
    };
    attempt();
  });
}

// Launch the REAL system Chrome with a debugging port and attach to it over CDP.
//
// Two things matter for Google to accept the session:
//  1. It must be genuine Chrome (not Playwright's Chromium) — Google rejects the
//     latter on Cloud Console ("browser may not be secure").
//  2. The debug port must be on a DEDICATED user-data-dir, NOT the default
//     profile — Chrome 136+ refuses to open the debug port on the default
//     profile (anti session-theft). A separate profile opens the port fine.
//
// Because a separate profile has no login, pass options.injectCookies=true to
// copy the decrypted Chrome cookies (chrome-cookies.mjs) into it via CDP, so the
// genuine-Chrome session is authenticated without a manual sign-in.
//
// Returns { browser, page, commander, close }. close() quits the spawned Chrome
// (closing the local debug port). `url` is opened in the connected context.
export async function connectSystemChrome(url, options = {}) {
  const {
    port = 9222,
    headless = false,
    dataDir,
    profileName = 'chrome-cdp-profile',
    injectCookies = false,
  } = options;
  const bin = findSystemChrome();
  if (!bin) {
    throw new Error(
      'System Chrome not found. Install Google Chrome, or use the cookies ' +
        'strategy for Gmail (Cloud Console needs the real browser).'
    );
  }
  // A dedicated profile (NOT the default) so Chrome 136+ actually opens the
  // debug port. Kept under data/ so a login here PERSISTS across runs: the saved
  // session is reused whenever the profile dir already exists, so the user signs
  // in a single time. `firstRun` (no dir yet) is the only case that needs the
  // cookie seed below.
  const profileDir = dataDir
    ? path.join(dataDir, profileName)
    : path.join(os.tmpdir(), profileName);
  const firstRun = !fs.existsSync(profileDir);
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Route this dedicated profile's password store to Chrome's built-in
    // "basic" backend, not the OS Keychain, so launching it raises no system
    // password dialog (bc-70). The one Keychain read we allow happens in
    // chrome-cookies.mjs; the injected session keeps working here.
    '--password-store=basic',
  ];
  if (headless) {
    args.push('--headless=new');
  }
  const child = spawn(bin, args, { stdio: 'ignore', detached: false });

  await waitForDebugPort(port);
  const playwright = await import('playwright');
  const browser = await playwright.chromium.connectOverCDP(
    `http://127.0.0.1:${port}`
  );
  const context = browser.contexts()[0] || (await browser.newContext());

  // Seed the genuine-Chrome session with the existing Google login — but ONLY on
  // the first run of this profile. Once signed in, the profile keeps the session
  // itself, so we skip injection (avoids a redundant Keychain prompt and never
  // overwrites the now-authoritative persisted session). Pass refresh:true to
  // force re-injection if the saved session goes stale.
  if (injectCookies && (firstRun || options.refresh === true)) {
    const cookies = readChromeCookies('google.com', {
      cacheDir: dataDir,
      refresh: options.refresh === true,
    });
    if (cookies.length) {
      await context.addCookies(cookies).catch(() => {});
    }
  }

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const bc = await loadBrowserCommander();
  const commander = bc.makeBrowserCommander({ page });
  const close = async () => {
    await browser.close().catch(() => {});
    try {
      child.kill();
    } catch {
      // already gone
    }
  };
  return { browser, page, commander, close, child };
}

// ---- session strategies ---------------------------------------------------

// A dedicated, persistent profile under data/ keeps a login alive between runs.
// We never launch against the user's real Chrome profile (it is locked while
// Chrome runs, and mixing automation into it is risky); the 'cookies' strategy
// instead copies decrypted cookies into this clean profile's session.

// ---- launch ---------------------------------------------------------------

// Launch a browser-commander session with the chosen Google login strategy and
// navigate to `url`. Returns { browser, page, commander, userDataDir }. This is
// the shared launcher behind both Gmail and Google Cloud Console automation, so
// the same reused login (decrypted Chrome cookies) drives either one.
export async function openBrowser(url, options = {}) {
  const {
    dataDir,
    strategy = 'profile',
    headless = false, // a visible window is needed for first-time login / captcha
    stateFile = path.join(dataDir, 'gmail-state.json'),
    profileName = 'gmail-browser-profile',
    waitUntil = 'domcontentloaded',
  } = options;

  const bc = await loadBrowserCommander();
  const userDataDir = path.join(dataDir, profileName);
  fs.mkdirSync(userDataDir, { recursive: true });

  // browser-commander's launchBrowser forwards userDataDir + headless. channel
  // (system Chrome, bc-57) and storageState (bc-58) are not wrapped yet.
  const { browser, page } = await bc.launchBrowser({
    engine: 'playwright',
    headless,
    userDataDir,
  });

  // Inject the session cookies for the chosen strategy via the raw context
  // (workaround for bc-58: no storageState/addCookies wrapper yet).
  const injected = [];
  if (strategy === 'cookies') {
    // Decrypt the Google cookies from the local Chrome profile and reuse them.
    // Cached under data/ so the Keychain prompt appears once per TTL, not every
    // run (pass refresh to force a fresh read).
    injected.push(
      ...readChromeCookies('google.com', {
        cacheDir: dataDir,
        refresh: options.refresh === true,
      })
    );
  } else if (strategy === 'state' && fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    injected.push(...(state.cookies || []));
  }
  if (injected.length && page.context) {
    await page.context().addCookies(injected);
  }

  const commander = bc.makeBrowserCommander({ page });
  await commander.goto({ url, waitUntil, timeout: 60000 });

  return { browser, page, commander, userDataDir };
}

// Launch a browser-commander session pointed at Gmail. Returns
// { browser, page, commander }. The caller drives it and closes the browser.
export async function openGmail(options = {}) {
  const { headless = false } = options;
  return await openBrowser(
    'https://mail.google.com/mail/u/0/#search/newer_than%3A90d',
    { ...options, headless, profileName: 'gmail-browser-profile' }
  );
}

// Persist the current session for portable reuse (workaround for bc-58:
// browser-commander has no saveStorageState wrapper yet).
export async function saveSession(page, stateFile) {
  if (!page.context) {
    return false;
  }
  const state = await page.context().storageState();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return true;
}

// Detect whether the current page is the Gmail inbox (logged in) or the Google
// sign-in page (needs the user to log in once).
export async function isLoggedIn(page) {
  // Workaround for bc-59 (no content()/evaluate wrapper): use raw page.
  const url = page.url();
  // A redirect to the sign-in host means we are not logged in.
  if (/accounts\.google\.com|ServiceLogin|signin/.test(url)) {
    return false;
  }
  // Language-neutral inbox markers (avoid text/aria-label which vary by locale):
  //   - the search form (role=search)
  //   - Gmail's main mail view container (role=main) / compose garbage-collector
  const markers = [
    'form[role="search"]',
    'div[role="main"]',
    'div[gh="tm"]', // Gmail top-menu toolbar attribute
    'div[role="navigation"]',
  ];
  for (const selector of markers) {
    const count = await page
      .locator(selector)
      .count()
      .catch(() => 0);
    if (count > 0) {
      return true;
    }
  }
  return false;
}

// Extract the raw HTML of the currently open message (workaround for bc-59).
export async function currentMessageHtml(page) {
  return await page.content();
}
