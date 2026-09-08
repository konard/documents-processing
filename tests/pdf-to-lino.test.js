import { describe, it, expect } from 'test-anywhere';
import {
  parseNa1a,
  parseLabelled,
  looksLikeNa1a,
  parseArgs,
} from '../src/pdf-to-lino.mjs';

// A page laid out the way `pdftotext -layout` renders the real form: two
// columns held apart by padding, values that wrap under their own label, and
// a right-hand label that sometimes follows the left value by a single space.
const FORM = [
  '                                                            VIET NAM E-VISA APPLICATION FORM',
  ' PERSONAL INFORMATION',
  '                                                         Surname: TRAVELLER                             Given name: JOHN ALEX',
  '                                                         1-2. Sex:                                      1.3. Date of birth (dd/mm/yyyy): [REDACTED]',
  'Portrait of applicant (recent photo, size 4x6cm,         1.4. Nationality: Wonderland                   1.5. Place of birth: Capital City, Wonderland',
  'straight, no hat, no glasses, polite clothes, white      1.6. ID Card number:                           1.7. Religion: Christianity',
  '2.1. To issue e-Visa for:                                2.2. E-Visa duration: 16/09/2026',
  'Single - entry             Multiple - entry              E- Visa valid from (dd/mm/yyyy): 16/09/2026 to: 14/12/2026',
  '3.2. Passport number: 712345678                                                                         3.3. Issuing Authority/Place of issue: CONSULATE',
  '                                                                                                        GENERAL, SOMEWHERE',
  '3.4. Date of issue (dd/mm/yyyy): [REDACTED]                                                             3.5. Expiry date (dd/mm/yyyy): [REDACTED]',
  '4.1. Contact address: Wonderland, 100000, Capital City, Long Boulevard 18A, apt. 16',
  '4.2. Current residential address (if contact address is different from current residential address): Wonderland, 100000, Capital City, Long',
  'Boulevard 18A, apt. 16',
  '4.3. Mobile phone number or landline phone number: +10000000001                                         4.4. Email address: someone@example.com',
  'a) Full name: JANE DOE                                                        b) Current residential address: Wonderland, 100000, Capital',
  '                                                                              City, Long Boulevard 18A, apt. 16',
  'c) Telephone number: +10000000002',
  '                                                                              d) Relationship: Aunt',
  '6.3. Intended duration of stay: 90 days                                6.4. Intended date of entry (dd/mm/yyyy): 16/09/2026',
  '6.5. Intended border gate of entry: Some Int Airport (Capital 6.6. Intended border gate of exit: Some Int Airport (Capital City)',
  'City)',
  '6.7. Residential address in Viet Nam: 100/14 Some Street, Some     6.8. Contact telephone number in Viet Nam:',
  'Ward, Capital',
  'Committed to declare temporary residence according to the',
  'PLACE OF REQUEST                                           DATE OF REQUEST (dd/mm/yyyy)',
  '                                                                    08/09/2026',
].join('\n');

describe('reading a Vietnam e-visa application form', () => {
  const record = parseNa1a(FORM);

  it('recognises the form by its heading', () => {
    expect(looksLikeNa1a(FORM)).toBe(true);
    expect(looksLikeNa1a('An unrelated invoice')).toBe(false);
  });

  it('keeps a value apart from the label beside it', () => {
    // Both sit on one line; the right-hand label must not join the left value.
    expect(record.surname).toBe('TRAVELLER');
    expect(record.givenName).toBe('JOHN ALEX');
    expect(record.nationality).toBe('Wonderland');
    expect(record.placeOfBirth).toBe('Capital City, Wonderland');
    expect(record.religion).toBe('Christianity');
  });

  it('reads the passport fields', () => {
    expect(record.passportNumber).toBe('712345678');
    expect(record.dateOfBirth).toBe('[REDACTED]');
    expect(record.passportIssueDate).toBe('[REDACTED]');
    expect(record.passportExpiryDate).toBe('[REDACTED]');
  });

  it('joins a value that wraps under its own label', () => {
    expect(record.issuingAuthority).toBe('CONSULATE GENERAL, SOMEWHERE');
    expect(record.homeAddress).toBe(
      'Wonderland, 100000, Capital City, Long Boulevard 18A, apt. 16'
    );
    expect(record.emergencyAddress).toBe(
      'Wonderland, 100000, Capital City, Long Boulevard 18A, apt. 16'
    );
  });

  it('separates the two border gates a single space apart', () => {
    expect(record.entryGate).toBe('Some Int Airport (Capital City)');
    expect(record.exitGate).toBe('Some Int Airport (Capital City)');
  });

  it('reads the contact and trip details', () => {
    expect(record.contactAddress).toBe(
      'Wonderland, 100000, Capital City, Long Boulevard 18A, apt. 16'
    );
    expect(record.phone).toBe('+10000000001');
    expect(record.email).toBe('someone@example.com');
    expect(record.emergencyName).toBe('JANE DOE');
    expect(record.emergencyPhone).toBe('+10000000002');
    expect(record.emergencyRelation).toBe('Aunt');
    expect(record.addressInVietnam).toBe(
      '100/14 Some Street, Some Ward, Capital'
    );
  });

  it('reads the dates that stand under a heading of their own', () => {
    expect(record.requestDate).toBe('08/09/2026');
    expect(record.visaFrom).toBe('16/09/2026');
    expect(record.visaTo).toBe('14/12/2026');
  });
});

describe('reading an unfamiliar page', () => {
  it('takes every labelled pair it finds', () => {
    const record = parseLabelled(
      ['Reference: AB1234    Issued: 01/02/2026', 'Holder: JOHN ALEX'].join(
        '\n'
      )
    );
    expect(record.reference).toBe('AB1234');
    expect(record.issued).toBe('01/02/2026');
    expect(record.holder).toBe('JOHN ALEX');
  });

  it('drops the section numbering from a label', () => {
    const record = parseLabelled('1.4. Nationality: Wonderland');
    expect(record.nationality).toBe('Wonderland');
  });
});

describe('the command line', () => {
  it('collects inputs and flags', () => {
    const options = parseArgs([
      'a.pdf',
      '--form',
      'auto',
      '--out',
      'records',
      '--json',
      'b.pdf',
    ]);
    expect(options.inputs).toEqual(['a.pdf', 'b.pdf']);
    expect(options.form).toBe('auto');
    expect(options.out).toBe('records');
    expect(options.json).toBe(true);
  });

  it('reads the application form by default', () => {
    expect(parseArgs(['a.pdf']).form).toBe('na1a');
    expect(parseArgs(['a.pdf']).json).toBe(false);
  });
});
