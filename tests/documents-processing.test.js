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
    'index.js',
    'ocr-lib.js',
    'pdf-image-tools.js',
  ]);

  const commandFiles = readdirSync('src').filter(
    (file) => file.endsWith('.js') && !NON_COMMANDS.has(file)
  );

  it('ships at least one runnable command script in src/', () => {
    expect(commandFiles.length > 0).toBe(true);
  });

  it('every command script begins with a node shebang', () => {
    for (const file of commandFiles) {
      const firstLine = readFileSync(`src/${file}`, 'utf8').split('\n', 1)[0];
      expect(firstLine).toBe('#!/usr/bin/env node');
    }
  });

  it('keeps the CLI dispatcher and library entry point in place', () => {
    expect(existsSync('src/index.js')).toBe(true);
    expect(existsSync('src/ocr-lib.js')).toBe(true);
    expect(existsSync('src/pdf-image-tools.js')).toBe(true);
  });
});
