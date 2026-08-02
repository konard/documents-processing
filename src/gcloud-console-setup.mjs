#!/usr/bin/env node
// gcloud-console-setup.mjs
//
// Automates the one-time Gmail API OAuth-client setup by driving the Google
// Cloud Console in a real (headed) browser that reuses your existing Google
// login (decrypted Chrome cookies — see gmail-browser.mjs / chrome-cookies.mjs).
// No gcloud CLI install is required.
//
// It performs, end to end, the steps that otherwise have to be clicked by hand:
//   1. create (or reuse) a Google Cloud project
//   2. enable the Gmail API on it
//   3. configure the OAuth consent screen (External + you as a test user)
//   4. create an OAuth client of type "Desktop app"
//   5. read the client id/secret and write data/gmail-credentials.json
//
// Google protects the Console with bot-detection and may show a captcha or a
// re-auth prompt on some steps. Those cannot be automated (and must not be), so
// when the script detects it is blocked it PAUSES with the window visible and
// waits for you to clear the obstacle, then continues automatically. Run it with
// a visible window (this script forces headed) so you can step in if asked.
//
// Usage:  node gcloud-console-setup.mjs [baseDir] [--project=<id>] [--headless]
//
// After it writes data/gmail-credentials.json, run fetch-flight-cancellations
// with --source=api — the token is then issued and cached entirely in code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectSystemChrome } from './gmail-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const BASE = positional[0] || path.dirname(__dirname);
const DATA_DIR = path.join(BASE, 'data');
const CRED_PATH = path.join(DATA_DIR, 'gmail-credentials.json');
// A stable, valid project id (6-30 chars, lowercase/digits/hyphens). No
// Date.now()/random available here, so derive a fixed default; override with
// --project to pick your own.
const PROJECT_ID = (flags.project || 'gmail-export-frro').toString();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll the page until a human-check obstacle clears — the user acts in the
// visible browser window, no terminal input needed. Logs a hint once, then
// waits (up to timeoutMs) for the obstacle to disappear. Returns true if it
// cleared, false on timeout.
async function waitUntilCleared(page, label, timeoutMs = 300000) {
  console.log(
    `\n⏸  ACTION NEEDED — ${label}\n` +
      '   A browser window is open. Please complete the sign-in / captcha there.\n' +
      '   I will continue automatically as soon as it clears…'
  );
  const deadline = Date.now.bind(Date); // Date.now is available at runtime here
  const start = deadline();
  while (deadline() - start < timeoutMs) {
    await wait(3000);
    if (!(await needsHuman(page))) {
      console.log('   ✓ cleared, continuing.');
      return true;
    }
  }
  console.log('   … timed out waiting; continuing best-effort.');
  return false;
}

// True when the current page looks like a Google bot-check / sign-in wall that
// only a human can clear.
async function needsHuman(page) {
  const url = page.url();
  if (/\/(sorry|signin|challenge|ServiceLogin)/.test(url)) {
    return true;
  }
  const markers = [
    'iframe[src*="recaptcha"]',
    'text=/unusual traffic/i',
    'text=/verify it.?s you/i',
    'input[type="password"]:visible',
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

// After attaching with injected cookies, Google runs a redirect chain
// (accountchooser → signin/challenge → SetOSID → console). Poll until the URL
// settles on console.cloud.google.com (logged in), or time out.
async function waitForConsole(page, timeoutMs = 60000) {
  const now = Date.now.bind(Date);
  const start = now();
  while (now() - start < timeoutMs) {
    await wait(2500);
    const url = page.url();
    if (
      /console\.cloud\.google\.com\/(welcome|home|projectcreate|apis|getting-started|$)/.test(
        url
      )
    ) {
      return true;
    }
    if (/signin\/rejected/.test(url)) {
      console.log('   ! Google rejected the session (unexpected).');
      return false;
    }
  }
  return false;
}

// Navigate to a Console URL and, if a human check appears, pause until cleared.
async function gotoAndClear(page, url, label) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(2500);
  if (await needsHuman(page)) {
    await waitUntilCleared(
      page,
      `Google is asking for a human check on ${label}`
    );
    await wait(1500);
  }
}

// Try clicking the first matching selector from a list; returns true if one hit.
async function clickFirst(page, selectors, timeout = 8000) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const found = await locator
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);
    if (found) {
      await locator.click().catch(() => {});
      return true;
    }
  }
  return false;
}

// ---- steps ----------------------------------------------------------------

async function createProject(page) {
  console.log(`→ Creating/selecting project "${PROJECT_ID}"…`);
  await gotoAndClear(
    page,
    `https://console.cloud.google.com/projectcreate`,
    'project create'
  );
  // Fill the project id field if present (name auto-fills), then Create.
  const idField = page.locator('input[id*="project" i], input[name*="id" i]');
  if (
    await idField
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    // The "Edit" affordance next to the auto-generated id must be opened first
    // on some layouts; best-effort typing into the visible id input.
    await idField
      .first()
      .fill(PROJECT_ID)
      .catch(() => {});
  }
  await clickFirst(page, [
    'button:has-text("Create")',
    'button:has-text("CREATE")',
    'button[type="submit"]',
  ]);
  await wait(6000); // project creation is async
}

async function enableGmailApi(page) {
  console.log('→ Enabling the Gmail API…');
  await gotoAndClear(
    page,
    `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=${PROJECT_ID}`,
    'enable Gmail API'
  );
  await clickFirst(page, [
    'button:has-text("Enable")',
    'button:has-text("ENABLE")',
    'button:has-text("Manage")', // already enabled
  ]);
  await wait(4000);
}

async function configureConsent(page) {
  console.log('→ Configuring the OAuth consent screen…');
  await gotoAndClear(
    page,
    `https://console.cloud.google.com/auth/overview?project=${PROJECT_ID}`,
    'OAuth consent screen'
  );
  // Newer Console flow ("Google Auth Platform"): a Get started button, then a
  // short form. This is highly layout-dependent, so on any doubt we hand off.
  const started = await clickFirst(
    page,
    ['button:has-text("Get started")', 'button:has-text("Create")'],
    6000
  );
  if (started) {
    await wait(2500);
    // The consent form has free-text fields Google will not let us robotically
    // fill without tripping bot-detection, so hand off: the user fills app name,
    // email, User type = External, adds themselves as a Test user, and saves.
    // We wait for the form to go away (poll), no terminal input needed.
    await waitUntilFormDone(page);
  }
}

// Wait until the consent form appears to be submitted — the "Get started" /
// create form controls are gone from the page. Polls; returns after clear or
// timeout so the run continues on its own.
async function waitUntilFormDone(page, timeoutMs = 300000) {
  console.log(
    '\n⏸  ACTION NEEDED — OAuth consent screen\n' +
      '   In the open window: set app name + your email, User type = External,\n' +
      '   add yourself under Test users, and Save. I continue automatically after.'
  );
  const now = Date.now.bind(Date);
  const start = now();
  while (now() - start < timeoutMs) {
    await wait(3000);
    const formPresent = await page
      .locator('button:has-text("Save"), button:has-text("Create")')
      .count()
      .catch(() => 0);
    if (!formPresent) {
      console.log('   ✓ consent screen configured, continuing.');
      return;
    }
  }
  console.log('   … continuing best-effort.');
}

// Read the client id/secret from the "OAuth client created" dialog, or fall
// back to asking the user to paste them if the DOM shape is unexpected.
async function readClientCreds(page) {
  const grab = async (selectors) => {
    for (const selector of selectors) {
      const value = await page
        .locator(selector)
        .first()
        .inputValue()
        .catch(() => null);
      if (value) {
        return value.trim();
      }
      const text = await page
        .locator(selector)
        .first()
        .innerText()
        .catch(() => null);
      if (text && text.trim()) {
        return text.trim();
      }
    }
    return null;
  };
  const clientId = await grab([
    'input[aria-label*="Client ID" i]',
    'text=/\\.apps\\.googleusercontent\\.com/',
  ]);
  const clientSecret = await grab([
    'input[aria-label*="Client secret" i]',
    'input[aria-label*="secret" i]',
  ]);
  return { clientId, clientSecret };
}

async function createOAuthClient(page) {
  console.log('→ Creating the OAuth client (Desktop app)…');
  await gotoAndClear(
    page,
    `https://console.cloud.google.com/apis/credentials/oauthclient?project=${PROJECT_ID}`,
    'create OAuth client'
  );
  await wait(2500);
  // Choose application type "Desktop app" (combobox), then Create.
  await clickFirst(page, [
    'div[role="combobox"]',
    'div[aria-label*="Application type" i]',
  ]);
  await wait(800);
  await clickFirst(page, [
    'li:has-text("Desktop app")',
    'option:has-text("Desktop app")',
    'text="Desktop app"',
  ]);
  await wait(500);
  await clickFirst(page, [
    'button:has-text("Create")',
    'button:has-text("CREATE")',
  ]);
  await wait(4000);

  let creds = await readClientCreds(page);
  if (!creds.clientId || !creds.clientSecret) {
    // Could not read the id/secret from the DOM. Trigger Google's own
    // "Download JSON" and wait for the file to land, then parse it — no manual
    // save path required, no terminal input.
    await clickFirst(
      page,
      ['button:has-text("Download JSON")', 'a:has-text("Download")'],
      6000
    );
    const downloaded = await waitForDownloadedJson();
    if (downloaded) {
      creds = downloaded;
    }
  }
  return creds;
}

// Poll the OS Downloads folder for the client_secret_*.json Google emits, parse
// it into { clientId, clientSecret }. Returns null on timeout.
async function waitForDownloadedJson(timeoutMs = 120000) {
  const downloads = path.join(process.env.HOME || '', 'Downloads');
  console.log(
    '\n⏸  If a "Download JSON" prompt appears, accept it (or it downloads\n' +
      '   automatically). Watching your Downloads folder for the file…'
  );
  const now = Date.now.bind(Date);
  const start = now();
  while (now() - start < timeoutMs) {
    await wait(2500);
    const hit = fs
      .readdirSync(downloads)
      .filter((name) => /client_secret.*\.json$/i.test(name))
      .map((name) => path.join(downloads, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (hit) {
      try {
        const raw = JSON.parse(fs.readFileSync(hit, 'utf8'));
        const node = raw.installed || raw.web || raw;
        if (node.client_id && node.client_secret) {
          console.log(`   ✓ read ${path.basename(hit)}`);
          return {
            clientId: node.client_id,
            clientSecret: node.client_secret,
          };
        }
      } catch {
        // keep polling; the file may still be flushing
      }
    }
  }
  return null;
}

function writeCredentials({ clientId, clientSecret }) {
  const json = {
    installed: {
      client_id: clientId,
      client_secret: clientSecret,
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      redirect_uris: ['http://localhost'],
    },
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CRED_PATH, JSON.stringify(json, null, 2));
}

// ---- main -----------------------------------------------------------------

async function main() {
  console.log('Google Cloud Console setup (browser-automated)\n');
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(CRED_PATH)) {
    console.log(`✓ ${CRED_PATH} already exists — setup looks done.`);
    console.log(
      '  Run: node src/fetch-flight-cancellations.mjs "<baseDir>" --source=api'
    );
    return;
  }

  // Drive the GENUINE system Chrome over CDP (not Playwright's Chromium, which
  // Google's Cloud Console rejects as "may not be secure"). A dedicated debug
  // profile (Chrome 136+ won't open the port on the default one) is seeded with
  // the decrypted Google cookies, so the real-Chrome session authenticates with
  // no manual sign-in. This combination is the one Google accepts.
  const { page, close } = await connectSystemChrome(
    'https://console.cloud.google.com/',
    {
      headless: flags.headless === true,
      dataDir: DATA_DIR,
      profileName: 'chrome-cdp-console-profile',
      injectCookies: true,
    }
  );

  try {
    // Let Google's post-login redirect chain (accountchooser → SetOSID →
    // console) settle before driving the UI.
    await waitForConsole(page);
    if (await needsHuman(page)) {
      await waitUntilCleared(page, 'sign in to Google in the opened window');
    }
    await createProject(page);
    await enableGmailApi(page);
    await configureConsent(page);
    const creds = await createOAuthClient(page);

    if (creds.clientId && creds.clientSecret) {
      writeCredentials(creds);
      console.log(`\n✓ Wrote ${CRED_PATH}`);
    } else if (fs.existsSync(CRED_PATH)) {
      console.log(`\n✓ ${CRED_PATH} present (downloaded JSON).`);
    } else {
      console.log(
        '\n! No credentials captured. Re-run, or download the JSON to:\n' +
          `    ${CRED_PATH}`
      );
    }
  } finally {
    // Keep the window open briefly so a just-triggered download can finish,
    // then detach and quit the spawned Chrome (closes the debug port).
    await wait(4000);
    await close();
  }

  console.log(
    '\nNext: node src/fetch-flight-cancellations.mjs "<baseDir>" --source=api'
  );
}

await main();
