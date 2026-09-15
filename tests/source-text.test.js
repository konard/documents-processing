import { describe, it, expect } from 'test-anywhere';
import { normalizeSourceText } from './source-text.js';

describe('source assertions on every operating system', () => {
  it('use LF function boundaries after a Windows checkout', () => {
    expect(normalizeSourceText('one\r\n}\r\ntwo')).toBe('one\n}\ntwo');
  });

  it('also normalizes a lone carriage return without changing LF text', () => {
    expect(normalizeSourceText('one\rtwo\nthree')).toBe('one\ntwo\nthree');
  });
});
