#!/usr/bin/env node

// documents-processing — a small dispatcher over the document-processing
// commands in src/. Each command is a standalone script named <command>.mjs
// (directly runnable with `node src/<command>.mjs`); running
// `documents-processing <command> [args...]` executes that script with the
// remaining arguments forwarded verbatim.

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const binDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(binDir, '..', 'src');

// The library modules are imported by the commands, not run directly.
const NON_COMMANDS = new Set([
  'index.mjs',
  'ocr-lib.mjs',
  'pdf-image-tools.mjs',
  'font-tools.mjs',
  'gmail-lib.mjs',
  'gmail-browser.mjs',
  'chrome-cookies.mjs',
  'eml-to-pdf.mjs',
]);

function listCommands() {
  return readdirSync(srcDir)
    .filter((file) => file.endsWith('.mjs') && !NON_COMMANDS.has(file))
    .map((file) => file.replace(/\.mjs$/, ''))
    .sort();
}

function readVersion() {
  const packageUrl = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(packageUrl, 'utf8')).version;
}

function usage() {
  const commands = listCommands()
    .map((name) => `  ${name}`)
    .join('\n');
  return [
    'Usage: documents-processing <command> [args...]',
    '',
    'Commands:',
    commands,
    '',
    'Options:',
    '  --help     Show this help',
    '  --version  Show package version',
    '',
    'Run a command with --help for its own usage.',
  ].join('\n');
}

export function runCli(argv) {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return 0;
  }

  if (command === '--version' || command === '-v') {
    console.log(readVersion());
    return 0;
  }

  if (!listCommands().includes(command)) {
    console.error(`Unknown command: ${command}`);
    console.error(usage());
    return 1;
  }

  const script = path.join(srcDir, `${command}.mjs`);
  const result = spawnSync(process.execPath, [script, ...rest], {
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

function isCliEntryPoint() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isCliEntryPoint()) {
  process.exitCode = runCli(process.argv.slice(2));
}
