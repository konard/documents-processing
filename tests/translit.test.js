import { describe, it, expect } from 'test-anywhere';
import { transliterate, toLatin, hasCyrillic } from '../src/translit.mjs';
import {
  checkName,
  checkDateText,
  normalizeName,
  normalizeApplicant,
  validateApplicant,
} from '../src/evisa-data.mjs';

describe('transliterate', () => {
  it('follows the passport, not the familiar spelling', () => {
    // ICAO 9303 is what the machine-readable zone uses, so a transliterated
    // name matches the one printed across the bottom of the document.
    expect(transliterate('ЯКОВЛЕВ')).toBe('IAKOVLEV');
    expect(transliterate('ЮРИЙ')).toBe('IURII');
    expect(transliterate('ЖУКОВ')).toBe('ZHUKOV');
    expect(transliterate('ЩЕРБАКОВ')).toBe('SHCHERBAKOV');
  });

  it('leaves Latin text untouched', () => {
    expect(transliterate('DOE')).toBe('DOE');
    expect(transliterate('MVD 0093')).toBe('MVD 0093');
  });

  it('converts only the Cyrillic part of mixed text', () => {
    expect(transliterate('МВД 0093')).toBe('MVD 0093');
  });

  it('drops the soft sign, which has no Latin form', () => {
    expect(transliterate('ОЛЬГА')).toBe('OLGA');
  });

  it('keeps the case of the original', () => {
    expect(transliterate('Москва')).toBe('Moskva');
  });

  it('handles Ukrainian and Belarusian letters', () => {
    expect(transliterate('ІВАНОВ')).toBe('IVANOV');
    expect(transliterate('ЄВГЕН')).toBe('IEVGEN');
  });
});

describe('toLatin', () => {
  it('reports whether it had to convert anything', () => {
    // Worth telling an applicant: the spelling on their visa has to match
    // their passport, so a conversion is a judgement they may want to check.
    expect(toLatin('ИВАНОВ').transliterated).toBe(true);
    expect(toLatin('IVANOV').transliterated).toBe(false);
  });

  it('detects Cyrillic anywhere in the text', () => {
    expect(hasCyrillic('MVD 0093')).toBe(false);
    expect(hasCyrillic('МВД 0093')).toBe(true);
  });
});

describe('checkName', () => {
  it('accepts a name written in Latin letters', () => {
    expect(checkName('ILIASHENKO')).toBe(null);
    expect(checkName("O'BRIEN")).toBe(null);
    expect(checkName('SMITH-JONES')).toBe(null);
  });

  it('refuses a name that is not in Latin letters', () => {
    expect(checkName('ИЛЬЯШЕНКО')).toContain('Latin letters');
  });

  it('names the character that does not belong', () => {
    // More use than refusing the whole value without saying why.
    expect(checkName('NIK0LAI')).toContain('"0"');
    expect(checkName('DOE2')).toContain('"2"');
  });

  it('refuses an empty name', () => {
    expect(checkName('')).toBe('is empty');
    expect(checkName(null)).toBe('is empty');
  });
});

describe('checkDateText', () => {
  it('accepts a date written in digits', () => {
    expect(checkDateText('[REDACTED]')).toBe(null);
    expect(checkDateText('[REDACTED]')).toBe(null);
  });

  it('refuses letters standing in for digits', () => {
    // O for 0 is the misreading that put a wrong birth year on a form.
    expect(checkDateText('O2/O3/199O')).toContain('"O"');
    expect(checkDateText('I2/03/1990')).toContain('"I"');
  });

  it('accepts a written-out month, which is unambiguous', () => {
    expect(checkDateText('12 MAR 1990')).toBe(null);
    expect(checkDateText('5-Jan-2024')).toBe(null);
  });
});

describe('normalizeName', () => {
  it('repairs a digit only when the text came from OCR', () => {
    // OCR confuses O with 0; a person typing a digit meant something by it.
    expect(normalizeName('NIK0LAI', { fromOcr: true })).toBe('[REDACTED]');
    expect(normalizeName('NIK0LAI')).toBe('NIK0LAI');
  });

  it('strips accents so the name matches the passport zone', () => {
    expect(normalizeName('José')).toBe('JOSE');
  });
});

describe('applicant validation', () => {
  it('transliterates a Cyrillic name and accepts it', () => {
    const out = normalizeApplicant({
      surname: 'ИЛЬЯШЕНКО',
      givenName: 'ВЯЧЕСЛАВ',
    });
    expect(out.surname).toBe('ILIASHENKO');
    expect(out.givenName).toBe('VIACHESLAV');
  });

  it('transliterates the other free-text fields too', () => {
    const out = normalizeApplicant({ passportIssuingAuthority: 'МВД 0093' });
    expect(out.passportIssuingAuthority).toBe('MVD 0093');
  });

  it('reports a typed digit in a name', () => {
    const result = validateApplicant(normalizeApplicant({ surname: 'DOE2' }));
    expect(result.errors.some((e) => e.startsWith('surname'))).toBe(true);
  });

  it('reports a letter standing in for a digit in a date', () => {
    const result = validateApplicant({ dateOfBirth: 'O2/03/1990' });
    expect(result.errors.some((e) => e.includes('dateOfBirth'))).toBe(true);
  });
});
