import { readFileSync } from 'node:fs';

/** Gives source text the LF boundaries used by structural assertions. */
export function normalizeSourceText(text) {
  return text.replace(/\r\n?/g, '\n');
}

/** Reads source with one newline convention on every test platform. */
export function readSource(file) {
  return normalizeSourceText(readFileSync(file, 'utf8'));
}
