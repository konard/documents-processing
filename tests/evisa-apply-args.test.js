import { describe, it, expect } from 'test-anywhere';
import { parseArgs } from '../src/evisa-apply.mjs';

describe('reading a passport and filling a form are separate jobs', () => {
  it('reads and stops when only --ocr is asked for', () => {
    // An --ocr run wants the reading. Opening a browser on an empty form
    // afterwards is a surprise, and one that costs a live page load.
    expect(parseArgs(['--ocr', 'passport.jpg']).readOnly).toBe(true);
  });

  it('fills when filling is asked for as well', () => {
    expect(parseArgs(['--ocr', '--fill', 'passport.jpg']).readOnly).toBe(false);
  });

  it('leaves an ordinary fill alone', () => {
    expect(parseArgs(['applicant.json']).readOnly).toBe(undefined);
    expect(parseArgs(['applicant.json']).ocr).toBe(false);
  });

  it('still takes --read-only on its own', () => {
    expect(parseArgs(['--read-only', 'applicant.json']).readOnly).toBe(true);
  });

  it('keeps --dry-run as it was', () => {
    expect(parseArgs(['--dry-run', 'applicant.json']).dryRun).toBe(true);
  });
});
