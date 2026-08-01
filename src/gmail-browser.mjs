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
import path from 'node:path';
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

// ---- session strategies ---------------------------------------------------

// A dedicated, persistent profile under data/ so a login survives between runs.
// We never launch against the user's real Chrome profile (it is locked while
// Chrome runs, and mixing automation into it is risky); the 'cookies' strategy
// instead copies decrypted cookies into this clean profile's session.
function resolveUserDataDir(dataDir) {
  const dir = path.join(dataDir, 'gmail-browser-profile');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- launch ---------------------------------------------------------------

// Launch a browser-commander session pointed at Gmail. Returns
// { browser, page, commander }. The caller drives it and closes the browser.
export async function openGmail(options = {}) {
  const {
    dataDir,
    strategy = 'profile',
    headless = false, // first-time login needs a visible window
    stateFile = path.join(dataDir, 'gmail-state.json'),
  } = options;

  const bc = await loadBrowserCommander();
  const userDataDir = resolveUserDataDir(dataDir);

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
  await commander.goto({
    url: 'https://mail.google.com/mail/u/0/#search/newer_than%3A90d',
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  return { browser, page, commander, userDataDir };
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
