#!/usr/bin/env node
// gmail-setup.mjs
//
// Automates as much of the one-time Gmail API setup as Google allows, so the
// only manual steps left are the ones Google deliberately protects (signing in
// to your own account and clicking "Allow").
//
// It uses the gcloud CLI to do the automatable parts:
//   1. verify gcloud is installed (prints install instructions if not)
//   2. sign in (gcloud auth login — opens Google's own consent in a browser)
//   3. create (or reuse) a Google Cloud project
//   4. enable the Gmail API on it
//
// Then it explains the ONE step that has no API — creating an OAuth client of
// type "Desktop app" at the credentials page — and where to drop the file
// (data/gmail-credentials.json). Gmail is a "restricted" scope, so a custom
// OAuth client is mandatory; gcloud's built-in client cannot request it.
//
// Once data/gmail-credentials.json exists, run fetch-flight-cancellations to
// issue the token and export mail — the token flow is fully in code.
//
// This script only orchestrates gcloud and prints guidance; it stores no
// secrets itself.
//
// Usage:  node gmail-setup.mjs [baseDir] [--project=<id>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

// Run a command, inheriting stdio so interactive gcloud prompts work.
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  return result.status === 0;
}

// Capture a command's stdout (used for reads that must not be interactive).
function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function hasGcloud() {
  return spawnSync('gcloud', ['--version'], { stdio: 'ignore' }).status === 0;
}

function printInstallHelp() {
  console.log(
    [
      'gcloud CLI is not installed. Install it, then re-run this command:',
      '',
      '  macOS (Homebrew):  brew install --cask google-cloud-sdk',
      '  Other platforms:   https://cloud.google.com/sdk/docs/install',
      '',
      'The gcloud path is optional — you can instead create the OAuth client',
      'manually (see the printed link below) and skip straight to',
      'fetch-flight-cancellations.',
    ].join('\n')
  );
}

// ---- main -----------------------------------------------------------------

console.log('Gmail API setup\n===============\n');

fs.mkdirSync(DATA_DIR, { recursive: true });

if (fs.existsSync(CRED_PATH)) {
  console.log(
    `✓ OAuth client already present at:\n    ${CRED_PATH}\n\n` +
      'Setup looks complete. Run fetch-flight-cancellations to issue the token\n' +
      'and export mail.'
  );
  process.exit(0);
}

if (hasGcloud()) {
  console.log('✓ gcloud CLI found.\n');

  // 1) sign in (Google's own browser consent — nothing is automated here)
  const account = capture('gcloud', [
    'config',
    'get-value',
    'account',
    '--quiet',
  ]);
  if (!account || account === '(unset)') {
    console.log('→ Signing in with gcloud (a browser window will open)…');
    run('gcloud', ['auth', 'login']);
  } else {
    console.log(`✓ Signed in as ${account}.`);
  }

  // 2) create or reuse a project
  const projectId =
    flags.project ||
    capture('gcloud', ['config', 'get-value', 'project', '--quiet']);
  if (projectId && projectId !== '(unset)') {
    console.log(`✓ Using project: ${projectId}`);
  } else {
    console.log(
      '! No project selected. Create one and re-run with --project=<id>, e.g.:\n' +
        '    gcloud projects create my-gmail-export-001 --set-as-default'
    );
  }

  // 3) enable the Gmail API
  if (projectId && projectId !== '(unset)') {
    console.log('→ Enabling the Gmail API…');
    run('gcloud', [
      'services',
      'enable',
      'gmail.googleapis.com',
      `--project=${projectId}`,
    ]);
  }
} else {
  printInstallHelp();
}

// The one unavoidable manual step: Gmail is a restricted scope, and Google has
// no API to create the "Desktop app" OAuth client it requires.
console.log(
  [
    '',
    'One manual step remains (Google provides no API for it):',
    '',
    '  1. Open:  https://console.cloud.google.com/apis/credentials',
    '  2. Configure the OAuth consent screen (External; add yourself as a',
    '     Test user; scope: .../auth/gmail.readonly).',
    '  3. Create Credentials → OAuth client ID → Application type "Desktop app".',
    '  4. Download the JSON and save it as:',
    `        ${CRED_PATH}`,
    '',
    'Then run fetch-flight-cancellations — it issues and caches the token in',
    'code (no further manual steps) and exports your cancellation emails.',
  ].join('\n')
);
