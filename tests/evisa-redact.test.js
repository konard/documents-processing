import { describe, it, expect } from 'test-anywhere';
import {
  spellingsOf,
  valuesToRedact,
  redactText,
  replacementsFile,
  worthSearching,
  REDACTED,
} from '../src/evisa-redact.mjs';

describe('finding every way a value is written', () => {
  it('finds a phone number however it is grouped', () => {
    // Written 123-45-67 in one place and 1234567 in another, it is one
    // number, and redacting one spelling leaves the other published.
    const spellings = spellingsOf('123-45-67');
    expect(spellings.includes('123-45-67')).toBe(true);
    expect(spellings.includes('1234567')).toBe(true);
  });

  it('finds a date in the orders it gets written in', () => {
    const spellings = spellingsOf('1990-02-01');
    expect(spellings.includes('01/02/1990')).toBe(true);
    expect(spellings.includes('01.02.1990')).toBe(true);
  });

  it('finds a name in upper and lower case', () => {
    const spellings = spellingsOf('Sample');
    expect(spellings.includes('SAMPLE')).toBe(true);
    expect(spellings.includes('sample')).toBe(true);
  });

  it('leaves a value too short to mean anything on its own', () => {
    // "Li" matches half the source; redacting it would redact the code.
    expect(spellingsOf('Li')).toEqual([]);
    expect(spellingsOf('')).toEqual([]);
    expect(spellingsOf(undefined)).toEqual([]);
  });

  it('takes a short value when it is named on purpose', () => {
    // Given explicitly, the caller has decided; a reading has not.
    expect(valuesToRedact({}, ['abc']).includes('abc')).toBe(true);
  });
});

describe('reading a passport for what identifies somebody', () => {
  it('takes the fields that name a person, not the rest', () => {
    const values = valuesToRedact({
      surname: 'TRAVELLER',
      givenName: 'SAMPLE',
      passportNumber: 'AB1234567',
      nationality: 'Russian Federation',
      sex: 'Male',
    });
    expect(values.includes('TRAVELLER')).toBe(true);
    expect(values.includes('AB1234567')).toBe(true);
    // A nationality and a sex identify nobody on their own, and redacting
    // them would take the word "Male" out of the source.
    expect(values.includes('Russian Federation')).toBe(false);
    expect(values.includes('Male')).toBe(false);
  });

  it('puts the longest first, so no fragment is orphaned', () => {
    // Redacting "SAMPLE" before "SAMPLE STREET 12" would leave
    // "[REDACTED] STREET 12" with the address still legible.
    const values = valuesToRedact({
      surname: 'SAMPLE',
      permanentAddress: 'SAMPLE STREET 12',
    });
    expect(values[0].length >= values[values.length - 1].length).toBe(true);
    const { text } = redactText('at SAMPLE STREET 12 today', values);
    expect(text.includes('STREET')).toBe(false);
  });
});

describe('taking the values out of a piece of text', () => {
  it('replaces every spelling it finds, and counts them', () => {
    const { text, removed } = redactText('TRAVELLER and traveller', [
      'TRAVELLER',
    ]);
    expect(text).toBe(`${REDACTED} and ${REDACTED}`);
    expect(removed).toBe(2);
  });

  it('leaves text holding none of them exactly as it was', () => {
    const said = 'const form = await openForm({ headless: true });';
    expect(redactText(said, ['TRAVELLER']).text).toBe(said);
    expect(redactText(said, ['TRAVELLER']).removed).toBe(0);
  });

  it('treats a value with regex characters as the literal it is', () => {
    // An address such as "406/14 Cong Hoa" holds a slash, and a phone a
    // "+"; taken as a pattern they would match the wrong things or throw.
    const { text } = redactText('at 406/14 Cong Hoa now', ['406/14 Cong Hoa']);
    expect(text).toBe(`at ${REDACTED} now`);
    expect(redactText('a+b', ['a+b']).text).toBe(REDACTED);
  });

  it('writes the replacement list git reads', () => {
    const written = replacementsFile(['SAMPLE']);
    expect(written).toBe(`literal:SAMPLE==>${REDACTED}\n`);
  });
});

describe('which files are worth searching', () => {
  it('leaves a picture alone, having no text to redact', () => {
    // Rewriting a PNG by pattern corrupts it.
    expect(worthSearching('docs/passport.png')).toBe(false);
    expect(worthSearching('a/b/scan.JPEG')).toBe(false);
    expect(worthSearching('form.pdf')).toBe(false);
  });

  it('searches anything that holds words', () => {
    expect(worthSearching('src/evisa-bot.mjs')).toBe(true);
    expect(worthSearching('data/traces/chat-1.lino')).toBe(true);
    expect(worthSearching('README.md')).toBe(true);
  });
});
