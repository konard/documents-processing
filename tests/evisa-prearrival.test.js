import { describe, it, expect } from 'test-anywhere';
import {
  PREARRIVAL_FIELDS,
  buildDeclaration,
  valueFor,
  fullNameOf,
  hasVisaDetails,
  VISA_FIELDS,
  windowOpensOn,
  nowInVietnam,
} from '../src/evisa-prearrival.mjs';

const APPLICANT = {
  surname: 'TRAVELLER',
  givenName: 'JOHN ALEX',
  fullName: 'TRAVELLER JOHN ALEX',
  sex: 'Male',
  dateOfBirth: '04/11/1988',
  nationality: 'Wonderland',
  passportNumber: '712345678',
  passportExpiryDate: '09/09/2030',
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

describe('the day the site starts taking the declaration', () => {
  // The site offers the day of arrival and the two before it, so filing for a
  // flight landing on the 16th opens on the 14th.
  const sept = (day) => Date.UTC(2026, 8, day);

  it('counts back two days from the landing', () => {
    const shut = windowOpensOn('16/09/2026', sept(12));
    expect(shut.opens).toBe('14/09/2026');
    expect(shut.days).toBe(2);
  });

  it('says nothing while the window is open', () => {
    // On the day it opens there is nothing to wait for, and on the day of the
    // flight itself there is nothing to wait for either.
    expect(windowOpensOn('16/09/2026', sept(14))).toBe(null);
    expect(windowOpensOn('16/09/2026', sept(16))).toBe(null);
  });

  it('says nothing while the flight is unknown', () => {
    // A traveller who has sent no ticket is told what is missing. A date
    // computed from nothing would be a date they could act on wrongly.
    expect(windowOpensOn(null)).toBe(null);
    expect(windowOpensOn('')).toBe(null);
    expect(windowOpensOn('sometime in September')).toBe(null);
  });

  it('counts the days in Vietnam, not where the traveller is', () => {
    // The site counts its three days in GMT+7. Late evening UTC is already
    // tomorrow there, and a bot counting in UTC would offer a day the site
    // has stopped offering.
    const lateOnThe12thUtc = Date.UTC(2026, 8, 12, 23, 0);
    expect(nowInVietnam(lateOnThe12thUtc)).toBe(sept(13));
    // Early morning UTC is the same day in Vietnam.
    expect(nowInVietnam(Date.UTC(2026, 8, 12, 1, 0))).toBe(sept(12));
  });
});
