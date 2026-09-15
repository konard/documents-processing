import { describe, it, expect } from 'test-anywhere';
import { parseSaneDate } from '../src/ocr-lib.mjs';

describe('a printed date read by OCR', () => {
  it('must be a real calendar day', () => {
    expect(parseSaneDate('30.04.2015')).toBe('30.04.2015');
    expect(parseSaneDate('29.02.2024')).toBe('29.02.2024');
    expect(parseSaneDate('31.04.2015')).toBe(null);
    expect(parseSaneDate('29.02.2023')).toBe(null);
    expect(parseSaneDate('00.01.2015')).toBe(null);
  });

  it('must fall in the years a passport in use can carry', () => {
    expect(parseSaneDate('01.01.1979')).toBe(null);
    expect(parseSaneDate('01.01.2036')).toBe(null);
    expect(parseSaneDate('not a date')).toBe(null);
  });
});
