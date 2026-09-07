import { describe, it, expect } from 'test-anywhere';
import {
  parseDate,
  toFormDate,
  inclusiveDays,
  normalizeName,
  normalizeApplicant,
  validateApplicant,
  mergeSources,
  canonicalBorderGate,
  canonicalPurpose,
} from '../src/evisa-data.mjs';

// The form rejects dates in the past, so the fixtures are built relative to
// today, so they keep working as time passes.
const dayMs = 86400000;
const atOffset = (days) => {
  const now = new Date();
  const base = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  return toFormDate(new Date(base + days * dayMs));
};

const baseApplicant = {
  surname: 'TRAVELLER',
  givenName: 'SAMPLE',
  dateOfBirth: '1987-03-12',
  sex: 'Male',
  nationality: 'Russia',
  email: 'traveller@example.com',
  validFrom: atOffset(30),
  validTo: atOffset(50),
  passportNumber: '712345678',
  passportExpiryDate: atOffset(2000),
  purpose: 'Tourist',
  entryDate: atOffset(35),
  entryBorderGate: 'Noi Bai Int Airport',
  exitBorderGate: 'Tan Son Nhat Int Airport (Ho Chi Minh City)',
};

describe('parseDate', () => {
  it('reads ISO dates produced by MRZ parsing', () => {
    expect(toFormDate(parseDate('1987-03-12'))).toBe('12/03/1987');
  });

  it('reads the DD/MM/YYYY and DD.MM.YYYY forms printed on documents', () => {
    expect(toFormDate(parseDate('12/03/1987'))).toBe('12/03/1987');
    expect(toFormDate(parseDate('12.03.1987'))).toBe('12/03/1987');
  });

  it('reads the DD MMM YYYY form used on visa stickers', () => {
    expect(toFormDate(parseDate('12 MAR 1987'))).toBe('12/03/1987');
    expect(toFormDate(parseDate('05-Jan-2024'))).toBe('05/01/2024');
  });

  it('rejects impossible calendar dates', () => {
    expect(parseDate('31/02/2024')).toBe(null);
    expect(parseDate('00/01/2024')).toBe(null);
  });

  it('rejects text that is not a date', () => {
    expect(parseDate('not a date')).toBe(null);
    expect(parseDate('')).toBe(null);
    expect(parseDate(null)).toBe(null);
  });
});

describe('inclusiveDays', () => {
  it('counts both endpoints', () => {
    expect(
      inclusiveDays(parseDate('01/06/2026'), parseDate('01/06/2026'))
    ).toBe(1);
    expect(
      inclusiveDays(parseDate('01/06/2026'), parseDate('30/06/2026'))
    ).toBe(30);
  });
});

describe('normalizeName', () => {
  it('upper-cases and strips diacritics to match the MRZ', () => {
    expect(normalizeName('Alex Example')).toBe('ALEX EXAMPLE');
    expect(normalizeName('José Ángel')).toBe('JOSE ANGEL');
  });

  it('collapses stray punctuation and whitespace', () => {
    expect(normalizeName('  Doe,   John ')).toBe('DOE JOHN');
  });
});

describe('normalizeApplicant', () => {
  it('rewrites every date into the form DD/MM/YYYY', () => {
    const out = normalizeApplicant({
      ...baseApplicant,
      dateOfBirth: '1987-03-12',
      passportExpiryDate: '2032-01-01',
    });
    expect(out.dateOfBirth).toBe('12/03/1987');
    expect(out.passportExpiryDate).toBe('01/01/2032');
  });

  it('mirrors the email into the confirmation field', () => {
    const out = normalizeApplicant(baseApplicant);
    expect(out.confirmEmail).toBe('traveller@example.com');
  });

  it('applies the safe default for each yes/no question', () => {
    const out = normalizeApplicant(baseApplicant);
    expect(out.multipleNationalities).toBe('No');
    expect(out.entryType).toBe('Single-entry');
    expect(out.dateOfBirthPrecision).toBe('Full');
  });

  it('converts booleans into the Yes/No labels the form shows', () => {
    const out = normalizeApplicant({
      ...baseApplicant,
      visitedVietnamLastYear: true,
      hasRelativesInVietnam: false,
    });
    expect(out.visitedVietnamLastYear).toBe('Yes');
    expect(out.hasRelativesInVietnam).toBe('No');
  });

  it('drops empty values, so no blanks are typed into the form', () => {
    // A field with no default: religion and passport type are filled in below.
    const out = normalizeApplicant({ ...baseApplicant, placeOfBirth: '' });
    expect('placeOfBirth' in out).toBe(false);
  });

  it('fills the required fields that have one usual answer', () => {
    // Both are required, and asking for them adds a step without adding
    // information. They stay editable in the browser.
    const out = normalizeApplicant(baseApplicant);
    expect(out.passportType).toBe('Ordinary passport');
    expect(out.religion).toBe('Christianity');
  });

  it('keeps an answer the applicant gave over the default', () => {
    const out = normalizeApplicant({
      ...baseApplicant,
      religion: 'Islam',
      passportType: 'Diplomatic passport',
    });
    expect(out.religion).toBe('Islam');
    expect(out.passportType).toBe('Diplomatic passport');
  });
});

describe('validateApplicant', () => {
  it('accepts a complete record', () => {
    const result = validateApplicant(normalizeApplicant(baseApplicant));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports every missing required field at once', () => {
    const result = validateApplicant(normalizeApplicant({ surname: 'ONLY' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('passportNumber'))).toBe(true);
    // A field with no default; the border gates and passport type are filled in.
    expect(result.errors.some((e) => e.includes('nationality'))).toBe(true);
  });

  it('rejects a validity window longer than 90 days', () => {
    const result = validateApplicant(
      normalizeApplicant({
        ...baseApplicant,
        validFrom: atOffset(10),
        validTo: atOffset(200),
      })
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('90 days'))).toBe(true);
  });

  it('accepts a window of exactly 90 days', () => {
    const result = validateApplicant(
      normalizeApplicant({
        ...baseApplicant,
        validFrom: atOffset(10),
        validTo: atOffset(99),
        entryDate: atOffset(11),
      })
    );
    expect(result.errors.some((e) => e.includes('90 days'))).toBe(false);
  });

  it('rejects a validity window that ends before it starts', () => {
    const result = validateApplicant(
      normalizeApplicant({
        ...baseApplicant,
        validFrom: atOffset(50),
        validTo: atOffset(30),
        entryDate: atOffset(50),
      })
    );
    expect(result.errors.some((e) => e.includes('before validFrom'))).toBe(
      true
    );
  });

  it('rejects an entry date outside the requested validity window', () => {
    const result = validateApplicant(
      normalizeApplicant({ ...baseApplicant, entryDate: atOffset(5) })
    );
    expect(result.errors.some((e) => e.includes('before the requested'))).toBe(
      true
    );
  });

  it('warns when the passport expires within 6 months of entry', () => {
    const result = validateApplicant(
      normalizeApplicant({
        ...baseApplicant,
        passportExpiryDate: atOffset(60),
      })
    );
    expect(result.warnings.some((w) => w.includes('6 months'))).toBe(true);
  });

  it('rejects a malformed email and a mismatched confirmation', () => {
    const bad = validateApplicant(
      normalizeApplicant({ ...baseApplicant, email: 'not-an-email' })
    );
    expect(bad.errors.some((e) => e.includes('valid address'))).toBe(true);

    const mismatch = validateApplicant(
      normalizeApplicant({
        ...baseApplicant,
        confirmEmail: 'other@example.com',
      })
    );
    expect(mismatch.errors.some((e) => e.includes('differ'))).toBe(true);
  });

  it('rejects a value longer than the form field allows', () => {
    const result = validateApplicant(
      normalizeApplicant({ ...baseApplicant, surname: 'A'.repeat(51) })
    );
    expect(result.errors.some((e) => e.includes('50 characters'))).toBe(true);
  });

  it('rejects a date that looks well-formed but is not a real day', () => {
    const result = validateApplicant(
      normalizeApplicant({ ...baseApplicant, dateOfBirth: '31/02/1990' })
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('dateOfBirth is not a valid date'))
    ).toBe(true);
  });

  it('rejects a validity window that starts in the past', () => {
    // The site shows "Grant e-Visa valid from cannot be earlier than the
    // current date" and refuses to proceed, so catch it before filling.
    const result = validateApplicant(
      normalizeApplicant({
        ...baseApplicant,
        validFrom: atOffset(-10),
        validTo: atOffset(20),
        entryDate: atOffset(5),
      })
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('validFrom is in the past'))
    ).toBe(true);
  });

  it('rejects an entry date in the past', () => {
    const result = validateApplicant(
      normalizeApplicant({
        ...baseApplicant,
        validFrom: atOffset(-30),
        validTo: atOffset(-5),
        entryDate: atOffset(-20),
      })
    );
    expect(
      result.errors.some((e) => e.includes('entryDate is in the past'))
    ).toBe(true);
  });

  it('accepts a window that starts today', () => {
    const result = validateApplicant(
      normalizeApplicant({
        ...baseApplicant,
        validFrom: atOffset(0),
        validTo: atOffset(30),
        entryDate: atOffset(1),
      })
    );
    expect(result.errors.some((e) => e.includes('in the past'))).toBe(false);
  });

  it('rejects a birth date in the future', () => {
    const result = validateApplicant(
      normalizeApplicant({ ...baseApplicant, dateOfBirth: '01/01/2999' })
    );
    expect(result.errors.some((e) => e.includes('future'))).toBe(true);
  });

  it('rejects a radio answer outside the offered options', () => {
    const result = validateApplicant({
      ...normalizeApplicant(baseApplicant),
      multipleNationalities: 'Maybe',
    });
    expect(result.errors.some((e) => e.includes('must be one of'))).toBe(true);
  });
});

describe('validateApplicant: dropdown values', () => {
  it('warns about an airport that is not an approved border gate', () => {
    const result = validateApplicant(
      normalizeApplicant({
        ...baseApplicant,
        entryBorderGate: 'Heathrow Airport',
      })
    );
    expect(result.warnings.some((w) => w.includes("form's list"))).toBe(true);
  });

  it('warns about unknown fields and stays valid', () => {
    const result = validateApplicant({
      ...normalizeApplicant(baseApplicant),
      favouriteColour: 'blue',
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('favouriteColour'))).toBe(
      true
    );
  });
});

describe('canonicalPurpose', () => {
  it('rewrites everyday wording to the option the form offers', () => {
    // The form lists "Tourist"; almost everyone writes "Tourism".
    expect(canonicalPurpose('Tourism')).toBe('Tourist');
    expect(canonicalPurpose('holiday')).toBe('Tourist');
    expect(canonicalPurpose('work')).toBe('Working');
    expect(canonicalPurpose('family visit')).toBe('Visiting relatives');
  });

  it('accepts the exact options unchanged, whatever the casing', () => {
    expect(canonicalPurpose('Tourist')).toBe('Tourist');
    expect(canonicalPurpose('business')).toBe('Business');
  });

  it('leaves wording it does not recognize for validation to flag', () => {
    expect(canonicalPurpose('Transiting to Laos')).toBe('Transiting to Laos');
  });
});

describe('canonicalBorderGate', () => {
  it('rewrites the instruction page wording to the form wording', () => {
    // The instructions say "Noi Bai Airport Border Gate"; the dropdown only
    // has "Noi Bai Int Airport".
    expect(canonicalBorderGate('Noi Bai Airport Border Gate')).toBe(
      'Noi Bai Int Airport'
    );
    expect(canonicalBorderGate('Tan Son Nhat Airport Border Gate')).toBe(
      'Tan Son Nhat Int Airport (Ho Chi Minh City)'
    );
  });

  it('resolves a bare airport name', () => {
    expect(canonicalBorderGate('Noi Bai')).toBe('Noi Bai Int Airport');
    expect(canonicalBorderGate('Da Nang')).toBe(
      'Da Nang International Airport'
    );
  });

  it('passes an exact option through untouched', () => {
    expect(canonicalBorderGate('Noi Bai Int Airport')).toBe(
      'Noi Bai Int Airport'
    );
  });

  it('leaves an unknown or ambiguous name untouched', () => {
    expect(canonicalBorderGate('Heathrow')).toBe('Heathrow');
    expect(canonicalBorderGate('')).toBe('');
  });

  it('normalizes border gates as part of normalizing an applicant', () => {
    const out = normalizeApplicant({
      ...baseApplicant,
      entryBorderGate: 'Noi Bai Airport Border Gate',
      purpose: 'Tourism',
    });
    expect(out.entryBorderGate).toBe('Noi Bai Int Airport');
    expect(out.purpose).toBe('Tourist');
  });
});

describe('mergeSources', () => {
  it('lets a later source override an earlier one', () => {
    const merged = mergeSources(
      { name: 'ocr', data: { surname: 'MISREAD', passportNumber: '111' } },
      { name: 'verified.json', data: { surname: 'CORRECT' } }
    );
    expect(merged.data.surname).toBe('CORRECT');
    expect(merged.data.passportNumber).toBe('111');
  });

  it('records where each value came from', () => {
    const merged = mergeSources(
      { name: 'ocr', data: { surname: 'A' } },
      { name: 'verified.json', data: { surname: 'B' } }
    );
    expect(merged.provenance.surname).toBe('verified.json');
  });

  it('does not let an empty later value erase a good earlier one', () => {
    const merged = mergeSources(
      { name: 'ocr', data: { surname: 'KEEP' } },
      { name: 'partial', data: { surname: '', givenName: 'NEW' } }
    );
    expect(merged.data.surname).toBe('KEEP');
    expect(merged.data.givenName).toBe('NEW');
  });
});
