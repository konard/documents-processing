import { describe, it, expect } from 'test-anywhere';
import { parseMrzLine1, parseMrzLine2 } from '../src/mrz-lib.mjs';

// A TD3 line 2 with correct check digits: passport 712345678 (3),
// date of birth 12 March 1987 (3), expiry 1 January 2032 (5).
const LINE1 = 'P<RUSTRAVELLER<<SAMPLE<<<<<<<<<<<<<<<<<<<';
const LINE2 = '7123456783RUS8703123M3201015<<<<<<<<<<<<<<06';

describe('parseMrzLine1', () => {
  it('splits the surname from the given names', () => {
    const parsed = parseMrzLine1(LINE1);
    expect(parsed.issuer).toBe('RUS');
    expect(parsed.surname).toBe('TRAVELLER');
    expect(parsed.given).toBe('SAMPLE');
  });

  it('reads a digit in a name back as the letter it must be', () => {
    // Line 1 holds only letters and filler, so a digit is always a misread.
    // Deleting it instead would silently shorten the name.
    const parsed = parseMrzLine1('P<UTOD0E<<J0HN<<<<<<<<<<<<<<');
    expect(parsed.surname).toBe('DOE');
    expect(parsed.given).toBe('JOHN');
  });

  it('returns null for a line that is not an MRZ first line', () => {
    expect(parseMrzLine1('NOT AN MRZ LINE')).toBe(null);
  });
});

describe('parseMrzLine2', () => {
  it('reads every field off a well-formed line', () => {
    const parsed = parseMrzLine2(LINE2);
    expect(parsed.passportNumber).toBe('712345678');
    expect(parsed.nationality).toBe('RUS');
    expect(parsed.dob).toBe('1987-03-12');
    expect(parsed.sex).toBe('M');
  });

  it('confirms each check digit on a consistent line', () => {
    const parsed = parseMrzLine2(LINE2);
    expect(parsed.passportCheckOk).toBe(true);
    expect(parsed.dobCheckOk).toBe(true);
    expect(parsed.expiryCheckOk).toBe(true);
  });

  it('flags a passport number whose check digit does not match', () => {
    // Same number, deliberately wrong check digit.
    const parsed = parseMrzLine2(LINE2.replace('7123456783', '7123456782'));
    expect(parsed.passportCheckOk).toBe(false);
  });

  it('reads an expiry after 2030 as this century, not 1930', () => {
    // A two-digit year of 32 must mean 2032; the birth-year pivot would give
    // 1932 and silently mark a valid passport as long expired.
    const parsed = parseMrzLine2(LINE2);
    expect(parsed.expiry).toBe('2032-01-01');
  });

  it('still reads a birth year before the pivot as last century', () => {
    const parsed = parseMrzLine2(LINE2);
    expect(parsed.dob.startsWith('19')).toBe(true);
  });

  it('reads a recently expired passport as past, not a century ahead', () => {
    // Expiry 1 January 2024, check digit 8.
    const line = '7123456783RUS8703123M2401018<<<<<<<<<<<<<<06';
    expect(parseMrzLine2(line).expiry).toBe('2024-01-01');
  });

  it('returns null for a line that does not match the TD3 shape', () => {
    expect(parseMrzLine2('SHORT')).toBe(null);
  });
});
