import { describe, it, expect } from 'test-anywhere';
import {
  crossCheck,
  valuesAgree,
  describeCrossCheck,
  SHARED_FIELDS,
} from '../src/passport-crosscheck.mjs';
import { repairByCheckDigit, parseMrzLine2 } from '../src/mrz-lib.mjs';

describe('valuesAgree', () => {
  it('ignores case, spacing and punctuation', () => {
    expect(valuesAgree('MOSCOW', 'moscow')).toBe(true);
    expect(valuesAgree('[REDACTED]', '[REDACTED]')).toBe(false);
    expect(valuesAgree('AB 123 456', 'AB123456')).toBe(true);
  });

  it('reports an unknown comparison when either side is missing', () => {
    expect(valuesAgree('X', undefined)).toBe(null);
    expect(valuesAgree(null, 'X')).toBe(null);
    expect(valuesAgree('', 'X')).toBe(null);
  });
});

describe('crossCheck', () => {
  const mrz = {
    surname: 'DOE',
    givenName: 'JOHN',
    passportNumber: '123456789',
    dateOfBirth: '[REDACTED]',
    sex: 'Male',
  };

  it('confirms a field both zones agree on', () => {
    const result = crossCheck(mrz, { ...mrz });
    expect(result.confirmed.sort()).toEqual([...SHARED_FIELDS].sort());
    expect(result.conflicting).toEqual([]);
    expect(result.fullyConfirmed).toBe(true);
  });

  it('reports a disagreement and does not pick silently', () => {
    const result = crossCheck(mrz, { ...mrz, dateOfBirth: '2010-03-02' });
    expect(result.fullyConfirmed).toBe(false);
    expect(result.conflicting.length).toBe(1);
    expect(result.conflicting[0].field).toBe('dateOfBirth');
  });

  it('leaves a disputed field empty, choosing no winner', () => {
    // Nothing available here can say which zone misread, so a chosen value
    // would be an unverified guess on a government form.
    const result = crossCheck(
      { ...mrz, dateOfBirth: '2010-03-02' },
      { ...mrz, dateOfBirth: '[REDACTED]' }
    );
    expect(result.data.dateOfBirth).toBe(undefined);
    expect(result.conflicting[0].mrz).toBe('2010-03-02');
    expect(result.conflicting[0].printed).toBe('[REDACTED]');
  });

  it('does not confirm a disputed field even if one side has a valid checksum', () => {
    const result = crossCheck(
      { ...mrz, passportNumber: '123456789' },
      { ...mrz, passportNumber: '123456780' }
    );
    expect(result.confirmed.includes('passportNumber')).toBe(false);
    expect(result.data.passportNumber).toBe(undefined);
    expect(result.fullyConfirmed).toBe(false);
  });

  it('carries through fields only the printed zone has', () => {
    const result = crossCheck(mrz, {
      ...mrz,
      placeOfBirth: 'MOSCOW',
      passportIssueDate: '2022-02-17',
    });
    expect(result.data.placeOfBirth).toBe('MOSCOW');
    expect(result.singleSource.includes('placeOfBirth')).toBe(true);
  });

  it('marks a field seen in only one zone as unconfirmed', () => {
    const result = crossCheck(mrz, { surname: 'DOE' });
    expect(result.confirmed).toEqual(['surname']);
    expect(result.singleSource.includes('passportNumber')).toBe(true);
    expect(result.fullyConfirmed).toBe(false);
  });

  it('names the field to check in its description', () => {
    const result = crossCheck(mrz, { ...mrz, dateOfBirth: '2010-03-02' });
    const text = describeCrossCheck(result).join('\n');
    expect(text.includes('CONFLICT in dateOfBirth')).toBe(true);
    expect(text.includes('check this by hand')).toBe(true);
  });
});

describe('repairByCheckDigit', () => {
  it('leaves a field that already matches alone', () => {
    // 900302 with check digit 6 is self-consistent.
    const result = repairByCheckDigit('900302', 6);
    expect(result.value).toBe('900302');
    expect(result.repaired).toBe(false);
  });

  it('corrects a single misread glyph, using the letter it was read as', () => {
    // Tesseract reads the 9 of 900302 as an I. Repair runs before letters are
    // flattened to digits, so the 9 is still among the candidates for `I`.
    const result = repairByCheckDigit('I00302', 6);
    expect(result.repaired).toBe(true);
    expect(result.value).toBe('900302');
  });

  it('is applied to dates only, never to a passport number', () => {
    // A date can be corroborated by the calendar; a passport number has only
    // its check digit, which many wrong candidates also satisfy. A guessed
    // number that looks verified is worse than an admitted unknown.
    const line = '7123456782RUS8703123M3201015<<<<<<<<<<<<<<06';
    const parsed = parseMrzLine2(line);
    expect(parsed.passportNumber).toBe('712345678');
    expect(parsed.passportCheckOk).toBe(false);
    expect(parsed.repaired.includes('passportNumber')).toBe(false);
  });

  it('refuses a repair when no candidate satisfies the check digit', () => {
    const result = repairByCheckDigit('123456', 0);
    expect(result.repaired).toBe(false);
    expect(result.value).toBe('123456');
  });

  it('respects a plausibility filter, so a fix cannot invent month 63', () => {
    const isRealMonth = (d) => +d.slice(2, 4) >= 1 && +d.slice(2, 4) <= 12;
    const bad = repairByCheckDigit('106302', 6, isRealMonth);
    expect(/^\d\d(0[1-9]|1[0-2])/.test(bad.value) || !bad.repaired).toBe(true);
  });
});

describe('parseMrzLine2 with an ambiguous glyph', () => {
  it('does not report a date it could not verify as confirmed', () => {
    // Birth date 900302 with the 9 read as I; the check digit says 6.
    const line = '1234567897RUSI003026M3001019<<<<<<<<<<<<<<0';
    const parsed = parseMrzLine2(line);
    // Either the check digit recovers the right date, or the field is flagged.
    // What must never happen is a wrong date reported as confirmed.
    // The check digit picks the 9 reading, recovering the true date.
    expect(parsed.dob).toBe('[REDACTED]');
    expect(parsed.dobCheckOk).toBe(true);
    expect(parsed.repaired.includes('dateOfBirth')).toBe(true);
  });

  it('still reads the fields whose glyphs were unambiguous', () => {
    const line = '1234567897RUSI003026M3001019<<<<<<<<<<<<<<0';
    const parsed = parseMrzLine2(line);
    expect(parsed.passportNumber).toBe('123456789');
    expect(parsed.passportCheckOk).toBe(true);
    expect(parsed.expiry).toBe('2030-01-01');
    expect(parsed.expiryCheckOk).toBe(true);
  });
});
