#!/usr/bin/env node
// gmail-auto-consent.mjs
//
// Completes the Gmail OAuth *consent* step with NO manual clicking, closing the
// last gap in the "whole cycle via script" goal. authorize() in gmail-lib.mjs
// prints a URL and waits for a human to open it, approve, and be redirected —
// this module does that approval automatically by driving the SAME genuine,
// already-signed-in system Chrome (connectSystemChrome, dedicated profile +
// injected cookies) that the Cloud Console setup uses.
//
// Flow: spin up a localhost callback listener → generate the auth URL with that
// loopback redirect → open it in real Chrome → click through the account picker
// and the consent ("Continue"/"Allow", plus the "unverified app → Advanced →
// Go to <app>" interstitial that Testing-mode clients show) → capture the
// ?code= on the loopback → exchange it for a token → write data/gmail-token.json.
//
// Google accepts this because it is a genuine browser with the user's real
// session — the same reason the Console automation works. If a step needs a
// human (rare captcha), run with --headed and act in the visible window.
//
// Usage:  node gmail-auto-consent.mjs [baseDir] [--headed] [--debug-shots]

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import { google } from 'googleapis';
import { loadCredentials } from './gmail-lib.mjs';
import { connectSystemChrome } from './gmail-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The Google account index that owns the OAuth client / consent screen. Pinned
// so the consent opens under the same account the client was created with.
const AUTHUSER = '0';

// Click the first matching selector that becomes visible; returns true on hit.
async function clickFirst(page, selectors, timeout = 6000) {
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

// Click a visible clickable element that CONTAINS the given substring, via a
// synthetic mouse click on its CENTRE (page.mouse.click by coordinates). This is
// how the "Sign in with Google" account tile must be clicked: it renders as a
// plain <button> wrapping the email text with no role/data-identifier hooks, and
// both a Playwright text-locator click and an in-page element.click() fail to
// advance it — a real coordinate mouse click on the tile is what Google honours
// (verified live). Returns true if a matching clickable was found and clicked.
async function clickElementContaining(page, substring) {
  const centre = await page
    .evaluate((needle) => {
      const doc = globalThis.document;
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      // Prefer the innermost clickable (button/link/li) that holds the text.
      const clickable = [
        ...doc.querySelectorAll('button, [role="button"], [role="link"], li'),
      ]
        .filter(isVisible)
        .find((element) => (element.textContent || '').includes(needle));
      if (!clickable) {
        return null;
      }
      const rect = clickable.getBoundingClientRect();
      return {
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
      };
    }, substring)
    .catch(() => null);
  if (!centre) {
    return false;
  }
  await page.mouse.click(centre.x, centre.y).catch(() => {});
  return true;
}

// Walk the consent UI: account tile (if a chooser appears), then the sequence of
// Continue/Allow buttons, including the Testing-mode "unverified app" detour
// (Advanced → "Go to <app> (unsafe)"). Loops because the screens appear one at a
// time and the redirect to the loopback ends it. `onShot` is an optional
// screenshot hook for debugging.
async function approveConsent(page, callbackHost, contactEmail, onShot) {
  for (let step = 0; step < 14; step += 1) {
    const url = page.url();
    // Success: Google redirected to our loopback with a code (or the page shows
    // the "authorized" confirmation our own listener returns).
    if (url.startsWith(callbackHost)) {
      return true;
    }
    await onShot?.(page, `consent-${String(step).padStart(2, '0')}`);

    // 1) Account chooser — pick the owning account by clicking the tile that
    // holds its email. The tile is a bare <button> with no data hooks, so a
    // direct DOM .click() (clickElementContaining) is what actually advances it.
    if (contactEmail) {
      const pickedAccount = await clickElementContaining(page, contactEmail);
      if (pickedAccount) {
        await wait(2500);
        continue;
      }
    }

    // 2) "unverified app" interstitial: expand Advanced, then "Go to <app>".
    await clickFirst(
      page,
      [
        'button:has-text("Advanced")',
        'a:has-text("Advanced")',
        '#details-button',
      ],
      1500
    );
    const wentUnsafe = await clickFirst(
      page,
      [
        'a:has-text("Go to")',
        'a[href*="continue"]:has-text("unsafe")',
        'a:has-text("(unsafe)")',
      ],
      1500
    );
    if (wentUnsafe) {
      await wait(2000);
      continue;
    }

    // 3) Main consent buttons: Continue / Allow / Select all then Continue.
    // Tick any scope checkboxes first so Continue is enabled.
    const scopeBox = page.locator('input[type="checkbox"]:visible').first();
    if (await scopeBox.isVisible().catch(() => false)) {
      await scopeBox.check().catch(() => {});
    }
    let proceeded = await clickFirst(
      page,
      [
        'button:has-text("Continue")',
        'button:has-text("Allow")',
        'button:has-text("Accept")',
        '[role="button"]:has-text("Continue")',
        '[role="button"]:has-text("Allow")',
      ],
      2500
    );
    // Fallback: some of these are bare buttons a Playwright click misses; a
    // direct DOM .click() advances them (same reason as the account tile).
    if (!proceeded) {
      proceeded =
        (await clickElementContaining(page, 'Continue')) ||
        (await clickElementContaining(page, 'Allow'));
    }
    if (proceeded) {
      await wait(2500);
      continue;
    }

    // Nothing actionable this round; wait for the page to advance on its own.
    await wait(1500);
  }
  return page.url().startsWith(callbackHost);
}

export async function autoConsent(baseDir, options = {}) {
  const { headless = true, debugShots = false } = options;
  const { clientId, clientSecret } = loadCredentials(baseDir);
  // The Google account whose tile to click in the chooser. Prefer an explicit
  // option, then USER_EMAILS (first address) — never hardcode an address.
  const contactEmail =
    options.email || (process.env.USER_EMAILS || '').split(',')[0].trim() || '';
  const dataDir = path.join(baseDir, 'data');
  const tokenFile = path.join(dataDir, 'gmail-token.json');
  const shotsDir = path.join(dataDir, 'consent-auth-debug');
  let shotIndex = 0;
  const onShot = debugShots
    ? async (page, name) => {
        fs.mkdirSync(shotsDir, { recursive: true });
        shotIndex += 1;
        const file = path.join(
          shotsDir,
          `${String(shotIndex).padStart(2, '0')}-${name}.png`
        );
        await page.screenshot({ path: file }).catch(() => {});
        console.log(`   [shot] ${file}`);
      }
    : undefined;

  if (fs.existsSync(tokenFile)) {
    console.log(`✓ ${tokenFile} already exists — consent already done.`);
    return tokenFile;
  }

  // 1) Local loopback listener that captures the ?code=.
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    const code = requestUrl.searchParams.get('code');
    const error = requestUrl.searchParams.get('error');
    response
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end('<h2>Authorized. You can close this tab.</h2>');
    if (code) {
      resolveCode(code);
    } else if (error) {
      rejectCode(new Error(`consent error: ${error}`));
    }
  });
  // A port that cannot be bound must fail the flow, not leave it waiting.
  server.on('error', rejectCode);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const callbackHost = `http://localhost:${port}`;
  const redirectUri = `${callbackHost}/callback`;

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri
  );
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    redirect_uri: redirectUri,
  });
  // Pin the account so the consent runs under the owning authuser.
  const authUrlPinned = `${authUrl}&authuser=${AUTHUSER}`;

  console.log('→ Opening the Google consent page in real Chrome…');
  const { page, close } = await connectSystemChrome(authUrlPinned, {
    port: 9611,
    headless,
    dataDir,
    profileName: 'chrome-cdp-console-profile',
    injectCookies: true,
  });

  try {
    await wait(3000);
    const approved = await approveConsent(
      page,
      callbackHost,
      contactEmail,
      onShot
    );
    if (!approved) {
      console.log(
        '   ! Consent did not reach the callback automatically. If a captcha or ' +
          'an unexpected screen is shown, re-run with --headed and approve it.'
      );
    }
    // 2) Wait for the captured code, then exchange it for a token.
    const code = await Promise.race([
      codePromise,
      wait(120000).then(() => {
        throw new Error('timed out waiting for the consent redirect');
      }),
    ]);
    const { tokens } = await oauth2Client.getToken(code);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2));
    console.log(`\n✓ Wrote ${tokenFile}`);
    return tokenFile;
  } finally {
    server.close();
    await wait(2000);
    await close();
  }
}

// ---- CLI ------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const positional = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith('--'));
  const headed = process.argv.includes('--headed');
  const debugShots = process.argv.includes('--debug-shots');
  const baseDir = positional[0] || path.dirname(__dirname);
  await autoConsent(baseDir, { headless: !headed, debugShots });
  console.log(
    '\nNext: node src/fetch-flight-cancellations.mjs "<baseDir>" --source=api'
  );
}
