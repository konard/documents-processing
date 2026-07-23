#!/usr/bin/env node
// rename-passport-entries.mjs
//
// Renames scanned entry-stamp pages in a folder to the person they belong to,
// driven by an EXTERNAL mapping file (no per-case data is baked into the code).
//
// The mapping is a JSON object of { "<sourceFileName>": "<targetFileName>" }.
// It is looked up, in order:
//   1. the path given with --map=<file.json>
//   2. a file named "rename-map.json" inside the target directory
//
// This keeps the tool universal: to rename a new set of scans, drop a
// rename-map.json next to them (or pass --map). Establish each mapping by
// reading the scan and cross-checking the passport / visa numbers on the page
// against the rest of that person's documents.
//
// Usage:  node rename-passport-entries.mjs [dir] [--map=<file.json>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const flags = process.argv.slice(2).filter((arg) => arg.startsWith('--'));

// Default the target folder to a passport-entries/ folder one level up.
const dir =
  positional[0] || path.join(path.dirname(scriptDir), 'passport-entries');

const mapFlag = flags.find((flag) => flag.startsWith('--map='));
const mapPath = mapFlag
  ? mapFlag.slice('--map='.length)
  : path.join(dir, 'rename-map.json');

if (!fs.existsSync(mapPath)) {
  console.error(`No mapping file found at: ${mapPath}`);
  console.error(
    'Provide one with --map=<file.json>, or place rename-map.json in the target folder.'
  );
  console.error(
    'It must be a JSON object of { "<sourceFileName>": "<targetFileName>" }.'
  );
  process.exit(1);
}

const mapping = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const entries = Object.entries(mapping);

let renamed = 0;
for (const [from, to] of entries) {
  const src = path.join(dir, from);
  const dst = path.join(dir, to);
  if (fs.existsSync(dst)) {
    console.log(`• already named: ${to}`);
    renamed++;
    continue;
  }
  if (!fs.existsSync(src)) {
    console.warn(`⚠ source not found (skipped): ${from}`);
    continue;
  }
  fs.renameSync(src, dst);
  console.log(`✓ ${from}  ->  ${to}`);
  renamed++;
}

console.log(
  `\nDone. ${renamed}/${entries.length} entry page(s) named in:\n  ${dir}`
);
