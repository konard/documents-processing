import { describe, it, expect } from 'test-anywhere';
import {
  PREARRIVAL_FIELDS,
  buildDeclaration,
  valueFor,
  fullNameOf,
  hasVisaDetails,
  VISA_FIELDS,
} from '../src/evisa-prearrival.mjs';

const APPLICANT = {
  surname: 'TRAVELLER',
  givenName: 'JOHN ALEX',
  fullName: 'TRAVELLER JOHN ALEX',
  sex: 'Male',
  dateOfBirth: '[REDACTED]',
  nationality: 'Wonderland',
  passportNumber: '712345678',
  passportExpiryDate: '[REDACTED]',
  email: 'someone@example.com',
  phone: '+10000000001',
  entryDate: '16/09/2026',
  purpose: 'Tourist',
  entryGate: 'Some Int Airport',
  addressInVietnam: '100/14 Some Street, Some Ward, Capital',
};

describe('the pre-arrival declaration', () => {
  it('describes every field the filed copy prints', () => {
    const keys = PREARRIVAL_FIELDS.map((f) => f.key);
    expect(keys.includes('fullName')).toBe(true);
    expect(keys.includes('visaNumber')).toBe(true);
    expect(keys.includes('accommodationAddress')).toBe(true);
    // Each field is named for the traveller and belongs to one of the three
    // parts the declaration is printed in.
    for (const field of PREARRIVAL_FIELDS) {
      expect(typeof field.label).toBe('string');
      expect(['passenger', 'visa', 'trip'].includes(field.group)).toBe(true);
    }
  });

  it('takes what the visa application already asked for', () => {
    const { values } = buildDeclaration(APPLICANT);
    expect(values.fullName).toBe('TRAVELLER JOHN ALEX');
    expect(values.passportNumber).toBe('712345678');
    expect(values.nationality).toBe('Wonderland');
    expect(values.arrivalDate).toBe('16/09/2026');
    expect(values.borderGate).toBe('Some Int Airport');
    expect(values.accommodationAddress).toBe(
      '100/14 Some Street, Some Ward, Capital'
    );
  });

  it('fills the values that are the same for every e-visa traveller', () => {
    const { values } = buildDeclaration(APPLICANT);
    expect(values.visaType).toBe('Electronic Visa (E-Visa)');
    expect(values.modeOfTravel).toBe('Air');
    expect(values.visaIssuedPlace).toContain('Immigration Department');
  });

  it('names the flight and the hotel as the questions still to ask', () => {
    const { missing } = buildDeclaration(APPLICANT);
    // Nothing about the flight or the stay was ever asked for the visa.
    expect(missing.includes('vehicleNumber')).toBe(true);
    expect(missing.includes('departureDate')).toBe(true);
    expect(missing.includes('accommodationType')).toBe(true);
    // Nor is the visa itself known until it is granted.
    expect(missing.includes('visaNumber')).toBe(true);
  });

  it('prefers a value given for this trip over the record', () => {
    const { values, missing } = buildDeclaration(APPLICANT, {
      vehicleNumber: 'XX1234',
      borderGate: 'Another Int Airport',
    });
    expect(values.vehicleNumber).toBe('XX1234');
    expect(values.borderGate).toBe('Another Int Airport');
    expect(missing.includes('vehicleNumber')).toBe(false);
  });

  it('treats an empty value as no value at all', () => {
    const field = { key: 'vehicleNumber', label: 'Vehicle' };
    expect(valueFor(field, {}, { vehicleNumber: '' })).toBe(null);
    expect(valueFor(field, {}, { vehicleNumber: 'XX1234' })).toBe('XX1234');
  });
});

describe('the name the declaration wants', () => {
  it('puts the surname first, as the passport does', () => {
    expect(fullNameOf(APPLICANT)).toBe('TRAVELLER JOHN ALEX');
  });

  it('gives nothing when no name is known', () => {
    expect(fullNameOf({})).toBe(null);
  });
});

describe('waiting on the granted visa', () => {
  it('knows the declaration cannot be completed without it', () => {
    const { values } = buildDeclaration(APPLICANT);
    expect(hasVisaDetails(values)).toBe(false);
  });

  it('is satisfied once the visa supplies its four values', () => {
    const extras = {
      visaNumber: 'EV0000001',
      visaIssueDate: '01/09/2026',
      visaExpiryDate: '30/11/2026',
    };
    const { values } = buildDeclaration(APPLICANT, extras);
    expect(hasVisaDetails(values)).toBe(true);
    for (const key of VISA_FIELDS) {
      expect(values[key] !== null && values[key] !== undefined).toBe(true);
    }
  });
});
