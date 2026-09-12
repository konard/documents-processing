import { describe, it, expect } from 'test-anywhere';
import {
  meaningOf,
  STATUSES,
  SEARCH_URL,
  readRegistration,
  canLookUp,
} from '../src/evisa-download.mjs';

describe('what the site says about an application', () => {
  it('searches on the page that actually holds the form', () => {
    expect(SEARCH_URL).toBe('https://evisa.gov.vn/e-visa/search');
  });

  it('reads the wordings the site uses', () => {
    expect(meaningOf('Processing')).toBe('waiting');
    expect(meaningOf('Approved')).toBe('granted');
    expect(meaningOf('Rejected')).toBe('refused');
  });

  it('ignores the case and the space around it', () => {
    expect(meaningOf('  PROCESSING  ')).toBe('waiting');
    expect(meaningOf('approved')).toBe('granted');
  });

  it('reads a wording that carries more than the status', () => {
    expect(meaningOf('Application status: Processing')).toBe('waiting');
  });

  it('admits when it does not recognise a wording', () => {
    // A status the site invents later must not be reported as anything
    // definite, least of all as granted.
    expect(meaningOf('Under further review')).toBe('unknown');
    expect(meaningOf('')).toBe('unknown');
    expect(meaningOf(null)).toBe('unknown');
    expect(meaningOf(undefined)).toBe('unknown');
  });

  it('maps every wording it knows to a meaning a person understands', () => {
    for (const meaning of Object.values(STATUSES)) {
      expect(
        ['waiting', 'unpaid', 'granted', 'refused'].includes(meaning)
      ).toBe(true);
    }
  });
});

describe('reading the registration dialog', () => {
  // The dialog the site shows once it accepts an application, as its lines
  // come off the page.
  const LINES = [
    'DECLARATION COMPLETED',
    'Electronic document code:',
    'E260908ABC00000000000',
    'Email:',
    'someone@example.com',
    'Date of birth:',
    '04/11/1988',
    'Passport:',
    '712345678',
  ];

  it('takes the code every later lookup is keyed on', () => {
    expect(readRegistration(LINES).applicationNumber).toBe(
      'E260908ABC00000000000'
    );
  });

  it('takes the other two answers the search page asks for', () => {
    const details = readRegistration(LINES);
    expect(details.email).toBe('someone@example.com');
    expect(details.dateOfBirth).toBe('04/11/1988');
    expect(details.passportNumber).toBe('712345678');
  });

  it('reads a dialog that put each value on its label line', () => {
    const details = readRegistration([
      'Electronic document code: E260908ABC00000000000',
      'Email: someone@example.com',
      'Date of birth: 04/11/1988',
    ]);
    expect(details.applicationNumber).toBe('E260908ABC00000000000');
    expect(details.email).toBe('someone@example.com');
    expect(details.dateOfBirth).toBe('04/11/1988');
  });

  it('finds nothing in a dialog that is not a registration', () => {
    expect(readRegistration(['Captcha invalid'])).toEqual({});
    expect(readRegistration([])).toEqual({});
  });

  it('knows when it has enough to look the application up', () => {
    expect(canLookUp(readRegistration(LINES))).toBe(true);
    // A code alone cannot be searched: the page asks for three things.
    expect(canLookUp({ applicationNumber: 'E260908ABC00000000000' })).toBe(
      false
    );
    expect(canLookUp({})).toBe(false);
  });
});
