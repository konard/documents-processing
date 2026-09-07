// env.mjs
//
// Reads a .env file into the environment.
//
// Small enough to keep here: the alternative is a dependency for twenty lines,
// and secrets are worth being able to read end to end.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads `.env` from the project root, if there is one.
 *
 * A variable already set in the environment wins, so a value passed on the
 * command line is not overridden by a stale file.
 */
export function loadEnv(file) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const target = file ?? path.join(root, '.env');
  if (!fs.existsSync(target)) {
    return {};
  }

  const loaded = {};
  for (const line of fs.readFileSync(target, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const index = trimmed.indexOf('=');
    if (index === -1) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed
      .slice(index + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    loaded[key] = value;
    process.env[key] ??= value;
  }
  return loaded;
}
