import { describe, it, expect } from 'test-anywhere';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

describe('documents-processing package metadata', () => {
  it('is named documents-processing and publishes publicly', () => {
    expect(packageJson.name).toBe('documents-processing');
    expect(packageJson.publishConfig).toEqual({ access: 'public' });
  });

  it('exposes the documents-processing CLI dispatcher', () => {
    expect(packageJson.bin).toEqual({
      'documents-processing': './bin/documents-processing.js',
    });
    expect(existsSync('bin/documents-processing.js')).toBe(true);
  });

  it('publishes only the package runtime surface', () => {
    expect(packageJson.files).toEqual([
      'bin/',
      'src/',
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
    ]);
  });
});

describe('documents-processing commands', () => {
  const NON_COMMANDS = new Set([
    'index.mjs',
    'ocr-lib.mjs',
    'pdf-image-tools.mjs',
    'font-tools.mjs',
    'gmail-lib.mjs',
    'gmail-browser.mjs',
    'gmail-browser-search.mjs',
    'chrome-cookies.mjs',
    'flight-relevance.mjs',
    'eml-to-pdf.mjs',
    'evisa-schema.mjs',
    'evisa-data.mjs',
    'evisa-sources.mjs',
    'evisa-passport.mjs',
    'evisa-fill.mjs',
    'mrz-lib.mjs',
    'passport-crosscheck.mjs',
    'mrz-readers.mjs',
    'mrz-consensus.mjs',
    'evisa-passport-consensus.mjs',
    'mrz-variants.mjs',
    'evisa-required.mjs',
    'evisa-bot.mjs',
    'evisa-session.mjs',
    'env.mjs',
    'translit.mjs',
    'evisa-log.mjs',
    'evisa-address.mjs',
    'evisa-home-address.mjs',
    'evisa-geocode.mjs',
    'evisa-passport-worker.mjs',
    'evisa-slice.mjs',
    'evisa-download.mjs',
    'evisa-documents.mjs',
    'evisa-store.mjs',
    'evisa-transcript.mjs',
    'evisa-batch.mjs',
    'evisa-commands.mjs',
    'evisa-sections.mjs',
    'evisa-messages.mjs',
    'evisa-vietnam-address.mjs',
    'evisa-image-role.mjs',
    'evisa-prearrival.mjs',
  ]);

  const commandFiles = readdirSync('src').filter(
    (file) => file.endsWith('.mjs') && !NON_COMMANDS.has(file)
  );

  it('ships at least one runnable command script in src/', () => {
    expect(commandFiles.length > 0).toBe(true);
  });

  it('every command script begins with a node shebang', () => {
    for (const file of commandFiles) {
      // Trim the trailing \r so the check holds on a CRLF checkout (Windows).
      const firstLine = readFileSync(`src/${file}`, 'utf8')
        .split('\n', 1)[0]
        .replace(/\r$/, '');
      expect(firstLine).toBe('#!/usr/bin/env node');
    }
  });

  it('keeps the CLI dispatcher and library entry point in place', () => {
    expect(existsSync('src/index.mjs')).toBe(true);
    expect(existsSync('src/ocr-lib.mjs')).toBe(true);
    expect(existsSync('src/pdf-image-tools.mjs')).toBe(true);
  });
});
