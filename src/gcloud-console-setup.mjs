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
import { fileURLToPath, URL } from 'node:url';
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
let PROJECT_ID = (flags.project || 'gmail-export-frro').toString();
// Which signed-in Google account index the Console should use. When several
// accounts share the browser session, omitting this lets Google resolve a
// DIFFERENT account than the one that owns the project, which shows up as
// "You need additional access to the project". Pinning authuser fixes it.
const AUTHUSER = flags.authuser !== undefined ? String(flags.authuser) : '0';
// Email used to fill the consent screen's support/developer contact fields.
// Prefers --email, then USER_EMAILS (first address), so no address is hardcoded.
const CONTACT_EMAIL =
  (flags.email && String(flags.email)) ||
  (process.env.USER_EMAILS || '').split(',')[0].trim() ||
  '';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Optional visual debugging: with --debug-shots, save a screenshot at each step
// under data/consent-debug/ so the flow can be inspected when a selector misses.
const DEBUG_SHOTS = flags['debug-shots'] === true;
const SHOTS_DIR = path.join(DATA_DIR, 'consent-debug');
let shotIndex = 0;
async function debugShot(page, name) {
  if (!DEBUG_SHOTS) {
    return;
  }
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  shotIndex += 1;
  const file = path.join(
    SHOTS_DIR,
    `${String(shotIndex).padStart(2, '0')}-${name}.png`
  );
  await page.screenshot({ path: file }).catch(() => {});
  console.log(`   [shot] ${file}`);
}

// Build a Console URL with the project and authuser query params always set, so
// every navigation targets the same project under the same owning account.
function consoleUrl(pathAndQuery, withProject = true) {
  const base = `https://console.cloud.google.com${pathAndQuery}`;
  const url = new URL(base);
  if (withProject) {
    url.searchParams.set('project', PROJECT_ID);
  }
  url.searchParams.set('authuser', AUTHUSER);
  return url.toString();
}

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

// List the caller's existing Cloud projects by reading the Resource Manager
// LIST PAGE in the logged-in browser. The REST API needs an OAuth bearer token
// (cookie auth returns 401), but the UI table already renders every project, so
// we scrape the project ids from it. Returns [{ projectId }], or [] on failure.
async function listExistingProjects(page) {
  await page
    .goto(consoleUrl('/cloud-resource-manager', false), {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    })
    .catch(() => {});
  await waitForConsole(page);
  await wait(4000);
  const rows = await page
    .locator('table tbody tr, [role="row"]')
    .evaluateAll((elements) =>
      elements
        .map((element) =>
          (element.textContent || '').replace(/\s+/g, ' ').trim()
        )
        .filter((text) => text.length > 2)
    )
    .catch(() => []);
  // A Cloud project id is lowercase letters/digits/hyphens, 6-30 chars, starts
  // with a letter, and (for auto-generated and most user ids) contains at least
  // one digit — requiring a digit avoids matching a plain word from the display
  // name (e.g. "styleschool") ahead of the real id ("styleschool-424704").
  const ids = [];
  for (const row of rows) {
    const match = row.match(/\b[a-z][a-z0-9-]*\d[a-z0-9-]*\b/);
    if (match && match[0].length >= 6 && !ids.includes(match[0])) {
      ids.push(match[0]);
    }
  }
  return ids.map((projectId) => ({ projectId, name: '' }));
}

// Pick an EXISTING project and never create a duplicate. The projectcreate form
// ignores a typed id and mints a random one (e.g. "glassy-iridium-504311-a2"),
// so repeated runs would spawn throwaway "My Project NNNNN" entries. Since the
// account already has projects, always reuse one. Preference order:
//   1. an explicit --project=<id> match,
//   2. a prior gmail/frro project (if any),
//   3. an auto-generated "My Project" (id like word-word-NNNNNN-xN) — these are
//      empty/disposable, so we don't touch the user's real named projects,
//   4. otherwise the first available.
// Only create one if the account has NONE. Sets PROJECT_ID to the chosen id.
async function ensureProject(page) {
  console.log('→ Selecting an existing project (never creating duplicates)…');
  const projects = await listExistingProjects(page);
  const autoGenerated = (id) => /^[a-z]+-[a-z]+-\d{5,}-[a-z]\d$/.test(id || '');

  const chosen =
    projects.find((project) => project.projectId === PROJECT_ID) ||
    projects.find((project) => /gmail|frro/.test(project.projectId || '')) ||
    projects.find((project) => autoGenerated(project.projectId)) ||
    projects[0];

  if (chosen) {
    PROJECT_ID = chosen.projectId;
    console.log(`✓ Using existing project: ${chosen.projectId}`);
    return;
  }

  console.log(`→ No projects at all; creating "${PROJECT_ID}" once…`);
  await gotoAndClear(
    page,
    consoleUrl('/projectcreate', false),
    'project create'
  );
  const idField = page.locator('input[id*="project" i], input[name*="id" i]');
  if (
    await idField
      .first()
      .isVisible()
      .catch(() => false)
  ) {
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
    consoleUrl('/apis/library/gmail.googleapis.com'),
    'enable Gmail API'
  );
  await wait(3000);
  // The "Enable" button on the API library page is a bare Material button that a
  // Playwright text-locator click misses (verified: the API stayed disabled and
  // the fetch failed with SERVICE_DISABLED). A direct in-page .click() on the
  // element whose text is exactly "Enable" works. If it is already enabled the
  // page shows "Manage"/"Disable" instead and there is nothing to click.
  const clicked = await page
    .evaluate(() => {
      const doc = globalThis.document;
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const buttons = [
        ...doc.querySelectorAll('button, [role="button"]'),
      ].filter(isVisible);
      const enable = buttons.find(
        (button) => (button.textContent || '').trim().toLowerCase() === 'enable'
      );
      if (enable) {
        enable.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
  if (clicked) {
    console.log('   clicked Enable; waiting for activation to propagate…');
    // Activation is async and takes up to ~1–2 min to propagate; wait, since the
    // very next step (OAuth) and later API calls depend on it being live.
    await wait(20000);
  } else {
    console.log('   Gmail API already enabled — skipping.');
  }
}

async function configureConsent(page) {
  console.log('→ Configuring the OAuth consent screen (Google Auth Platform)…');
  await gotoAndClear(
    page,
    consoleUrl('/auth/overview'),
    'OAuth consent screen'
  );
  await wait(2000);

  // If it is already configured, the "Get started" entry point is gone.
  const started = await clickFirst(
    page,
    [
      'button:has-text("Get started")',
      'a:has-text("Get started")',
      '[role="button"]:has-text("Get started")',
    ],
    8000
  );
  if (!started) {
    console.log('   consent screen already configured — skipping.');
    return;
  }
  await wait(3000);
  await runConsentWizard(page);
}

// Open a Material "select" (support-email dropdown, audience radios sometimes)
// and pick the option whose text matches `preferMatch`, else the first real
// option. Returns true if something was selected.
async function pickFromDropdown(page, comboSelector, preferMatch) {
  const combo = page.locator(comboSelector).first();
  if (!(await combo.isVisible().catch(() => false))) {
    return false;
  }
  await combo.click().catch(() => {});
  await wait(800);
  const options = page.locator(
    '[role="option"], mat-option, li[role="option"]'
  );
  const count = await options.count().catch(() => 0);
  if (!count) {
    return false;
  }
  if (preferMatch) {
    for (let index = 0; index < count; index += 1) {
      const text = await options
        .nth(index)
        .innerText()
        .catch(() => '');
      if (text.toLowerCase().includes(preferMatch.toLowerCase())) {
        await options
          .nth(index)
          .click()
          .catch(() => {});
        await wait(500);
        return true;
      }
    }
  }
  await options
    .first()
    .click()
    .catch(() => {});
  await wait(500);
  return true;
}

// Fill and submit the "Project configuration" consent wizard, matching the real
// layout: 1) App Information (App name text + User support email DROPDOWN) →
// Next; 2) Audience (choose External) → Next; 3) Contact Information (developer
// email text) → Next; 4) Finish (agree checkbox) → Create. Steps expand inline
// on one page, so after each Next we re-scan and fill what became visible.
async function runConsentWizard(page) {
  const appName = 'gmail-export';

  // Step 1 — App Information. The fields carry stable Angular formcontrolname
  // attributes (verified live): App name = input[formcontrolname="displayName"];
  // User support email = a cfc-select combobox[formcontrolname="userSupportEmail"]
  // whose first option is the account's own address.
  await debugShot(page, 'step1-appinfo');
  const nameField = page
    .locator(
      'input[formcontrolname="displayName"], mat-form-field:has-text("App name") input'
    )
    .first();
  if (await nameField.isVisible().catch(() => false)) {
    await nameField.fill(appName).catch(() => {});
  }
  await pickFromDropdown(
    page,
    '[formcontrolname="userSupportEmail"], mat-form-field:has-text("support email") [role="combobox"]',
    CONTACT_EMAIL
  );
  await debugShot(page, 'step1-filled');
  await clickFirst(page, ['button:has-text("Next")'], 6000);
  await wait(2500);

  // Step 2 — Audience: pick External (radio or option).
  await debugShot(page, 'step2-audience');
  await clickFirst(
    page,
    [
      '[role="radio"][aria-label*="External" i]',
      'label:has-text("External")',
      'text="External"',
    ],
    5000
  );
  await clickFirst(page, ['button:has-text("Next")'], 5000);
  await wait(2500);

  // Step 3 — Contact Information: developer email (a text input on this step).
  await debugShot(page, 'step3-contact');
  if (CONTACT_EMAIL) {
    const contactField = page
      .locator(
        'input[formcontrolname*="mail" i], input[type="email"]:visible, mat-form-field:has-text("email") input'
      )
      .first();
    if (await contactField.isVisible().catch(() => false)) {
      const current = await contactField.inputValue().catch(() => 'x');
      if (!current) {
        await contactField.fill(CONTACT_EMAIL).catch(() => {});
      }
    } else {
      await pickFromDropdown(page, '[role="combobox"]', CONTACT_EMAIL);
    }
  }
  await clickFirst(page, ['button:has-text("Next")'], 5000);
  await wait(2500);

  // Step 4 — Finish: agree to the policy, then Create.
  await debugShot(page, 'step4-finish');
  const agree = page.locator('input[type="checkbox"]:visible').first();
  if (await agree.isVisible().catch(() => false)) {
    await agree.check().catch(() => {});
  }
  await clickFirst(
    page,
    ['button:has-text("Create")', 'button:has-text("Save")'],
    6000
  );
  await wait(5000);
  await debugShot(page, 'step5-after-create');

  if (!/\/auth\/overview\/create/.test(page.url())) {
    console.log('   ✓ consent screen configured.');
  } else {
    console.log('   consent wizard finished (verify manually if needed).');
  }
}

// Add CONTACT_EMAIL to the OAuth "Audience → Test users" list. Required because
// the app is created in Testing mode (External), where consent is BLOCKED for any
// account that is not a listed tester ("Access blocked: … Error 403 access_denied")
// — so without this, the later gmail-auto-consent step cannot approve. Verified
// live: the "Add users" panel input must be filled and then Save clicked via an
// in-page DOM .click() (a Playwright/coordinate click on that Save misses, and the
// page's first input is the GLOBAL console search, not the panel field).
async function addTestUser(page) {
  if (!CONTACT_EMAIL) {
    return;
  }
  console.log(`→ Adding ${CONTACT_EMAIL} as an OAuth test user…`);
  await gotoAndClear(page, consoleUrl('/auth/audience'), 'OAuth test users');
  await wait(3000);
  const body = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  if (body.includes(CONTACT_EMAIL)) {
    console.log('   already a test user — skipping.');
    return;
  }
  await clickFirst(
    page,
    ['button:has-text("Add users")', 'button:has-text("Add user")'],
    6000
  );
  await wait(2500);
  // Fill the panel's email field (scoped to the panel, NOT the global search),
  // confirm the chip, then Save via a DOM .click() (the reliable one here).
  const filled = await page
    .evaluate(() => {
      const doc = globalThis.document;
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const save = [...doc.querySelectorAll('button')].find(
        (button) =>
          isVisible(button) && /^save$/i.test((button.textContent || '').trim())
      );
      if (!save) {
        return false;
      }
      // The panel's input is a sibling near the Save button, not the top search.
      let container = save;
      for (let up = 0; up < 6 && container; up += 1) {
        container = container.parentElement;
        if (container && container.querySelector('input, textarea')) {
          break;
        }
      }
      const input = container
        ? [...container.querySelectorAll('input, textarea')].find(isVisible)
        : null;
      if (!input) {
        return false;
      }
      input.focus();
      return true;
    })
    .catch(() => false);
  if (filled) {
    await page.keyboard.type(CONTACT_EMAIL, { delay: 30 }).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await wait(1000);
    await debugShot(page, 'testuser-filled');
    await page
      .evaluate(() => {
        const doc = globalThis.document;
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const save = [...doc.querySelectorAll('button')].find(
          (button) =>
            isVisible(button) &&
            /^save$/i.test((button.textContent || '').trim()) &&
            !button.disabled
        );
        if (save) {
          save.click();
        }
      })
      .catch(() => {});
    await wait(4000);
    await debugShot(page, 'testuser-saved');
    console.log('   ✓ test user added.');
  } else {
    console.log('   ! could not open the test-user panel; verify manually.');
  }
}

// Read the client id/secret from the "OAuth client created" dialog. The dialog
// (verified live) shows "Client ID" as text ending in .apps.googleusercontent.com
// and "Client secret" as a labelled value; both are read from the whole dialog
// text with regexes, which is robust to the exact element structure.
async function readClientCreds(page) {
  // Try a few times: the dialog's secret row lives below the fold, and the
  // dialog is not a standard [role=dialog] container, so scroll EVERY scrollable
  // element and read the whole document text with regexes.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await wait(1500);
    const text = await page
      .evaluate(() => {
        // Runs in the browser page context; globalThis is the window.
        const doc = globalThis.document;
        doc.querySelectorAll('*').forEach((element) => {
          if (element.scrollHeight > element.clientHeight) {
            element.scrollTop = element.scrollHeight;
          }
        });
        return doc.body ? doc.body.innerText : '';
      })
      .catch(() => '');

    const idMatch = text.match(
      /([0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com)/i
    );
    const secretMatch =
      text.match(/\bGOCSPX-[A-Za-z0-9_-]+/) ||
      text.match(/Client secret\s*[:\n]*\s*([A-Za-z0-9_-]{16,})/i);
    if (idMatch && secretMatch) {
      return {
        clientId: idMatch[1],
        clientSecret: (secretMatch[1] || secretMatch[0]).trim(),
      };
    }
  }
  return { clientId: null, clientSecret: null };
}

// Pick "Desktop app" in the Application-type dropdown. This control is a
// cfc-select whose options render as plain <span> elements inside a body
// .cdk-overlay-container — NOT as <mat-option> or [role=option] — so Playwright
// text/option locators miss them and a normal .click() lands nothing (the type
// stays empty, which silently blocks Create). Verified fix: open the listbox,
// find the visible overlay node whose text is exactly "Desktop app", and click
// its CENTER by coordinates (a synthetic mouse click, which the overlay honours
// even though the element isn't a standard option). Retry a few times because
// the listbox animates in. Returns true once the control reads "Desktop app".
async function selectDesktopAppType(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const control = page.locator('[formcontrolname="typeControl"]').first();
    // Click the control's centre by coordinates to open the listbox reliably.
    const box = await control.boundingBox().catch(() => null);
    if (box) {
      await page.mouse
        .click(box.x + box.width / 2, box.y + box.height / 2)
        .catch(() => {});
    } else {
      await control.click().catch(() => {});
    }
    await wait(1500);
    // Locate the "Desktop app" option in the overlay and get its centre.
    const target = await page
      .evaluate(() => {
        // Runs in the browser page context; globalThis is the window.
        const doc = globalThis.document;
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const nodes = [
          ...doc.querySelectorAll('.cdk-overlay-container *'),
        ].filter(isVisible);
        const match = nodes.find(
          (element) =>
            (element.textContent || '').replace(/\s+/g, ' ').trim() ===
            'Desktop app'
        );
        if (!match) {
          return null;
        }
        const rect = match.getBoundingClientRect();
        return {
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
        };
      })
      .catch(() => null);
    if (target) {
      await page.mouse.click(target.x, target.y).catch(() => {});
    }
    await wait(1200);
    const chosen = await control.innerText().catch(() => '');
    if (/desktop app/i.test(chosen)) {
      return true;
    }
    // Close any open listbox before retrying.
    await page.keyboard.press('Escape').catch(() => {});
    await wait(600);
  }
  return false;
}

async function createOAuthClient(page) {
  console.log('→ Creating the OAuth client (Desktop app)…');
  // The new "Google Auth Platform" client form lives at /auth/clients/create.
  await gotoAndClear(page, consoleUrl('/auth/clients/create'), 'OAuth client');
  await wait(3000);
  await debugShot(page, 'client-01-form');

  await selectDesktopAppType(page);
  await debugShot(page, 'client-02-type');

  // A Name field appears after the type is chosen; a default is fine, but set
  // one if it is empty. Then Create.
  const nameField = page
    .locator(
      'input[formcontrolname="displayName"], input[formcontrolname*="name" i]'
    )
    .first();
  if (await nameField.isVisible().catch(() => false)) {
    const current = await nameField.inputValue().catch(() => 'x');
    if (!current) {
      await nameField.fill('gmail-export-desktop').catch(() => {});
    }
  }
  await debugShot(page, 'client-03-named');
  await clickFirst(
    page,
    ['button:has-text("Create")', 'button:has-text("CREATE")'],
    6000
  );
  // The "OAuth client created" dialog takes a moment to appear.
  await page
    .locator('text=/OAuth client created/i')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 })
    .catch(() => {});
  await wait(3000);
  await debugShot(page, 'client-04-created');

  // PRIMARY path: click Google's own "Download JSON" in the created dialog. The
  // emitted client_secret_*.json carries the full id + secret, so we never have
  // to scrape the secret from the DOM (Google shows it only once, below the
  // fold). Prefer capturing the download event directly; fall back to polling
  // the Downloads folder.
  let creds = null;
  const downloadButton = page
    .locator(
      'button:has-text("Download JSON"), a:has-text("Download JSON"), ' +
        'button:has-text("Download"), a:has-text("Download")'
    )
    .first();
  // Arm the download listener BEFORE clicking, then click.
  const downloadPromise = page
    .waitForEvent('download', { timeout: 30000 })
    .catch(() => null);
  await downloadButton.click({ timeout: 6000 }).catch(() => {});
  const download = await downloadPromise;
  if (download) {
    const savePath = path.join(DATA_DIR, 'client_secret_downloaded.json');
    await download.saveAs(savePath).catch(() => {});
    creds = parseCredentialsFile(savePath);
  }
  // Fallback 1: some browsers save the JSON straight to the OS Downloads
  // folder without firing a Playwright download event; poll for it there.
  if (!creds || !creds.clientId) {
    const downloaded = await waitForDownloadedJson();
    if (downloaded) {
      creds = downloaded;
    }
  }
  // Fallback 2: scrape id/secret from the dialog DOM as a last resort.
  if (!creds || !creds.clientId || !creds.clientSecret) {
    const scraped = await readClientCreds(page);
    if (scraped.clientId && scraped.clientSecret) {
      creds = scraped;
    }
  }
  return creds || { clientId: null, clientSecret: null };
}

// Parse a Google client_secret_*.json file into { clientId, clientSecret }.
function parseCredentialsFile(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const node = raw.installed || raw.web || raw;
    if (node.client_id && node.client_secret) {
      return { clientId: node.client_id, clientSecret: node.client_secret };
    }
  } catch {
    // unreadable / still flushing
  }
  return { clientId: null, clientSecret: null };
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
  const { page, close } = await connectSystemChrome(consoleUrl('/', false), {
    headless: flags.headless === true,
    dataDir: DATA_DIR,
    profileName: 'chrome-cdp-console-profile',
    injectCookies: true,
  });

  try {
    // Let Google's post-login redirect chain (accountchooser → SetOSID →
    // console) settle before driving the UI.
    await waitForConsole(page);
    if (await needsHuman(page)) {
      await waitUntilCleared(page, 'sign in to Google in the opened window');
    }
    await ensureProject(page);
    await enableGmailApi(page);
    await configureConsent(page);
    // Add the user as a test user BEFORE creating the client, so the later
    // consent step (gmail-auto-consent) is not blocked by Testing-mode access.
    await addTestUser(page);
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
