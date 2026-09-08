// evisa-prearrival.mjs
//
// The pre-arrival declaration every visitor files before flying to Viet Nam,
// at prearrival.immigration.gov.vn.
//
// This is the step after the visa: the visa says you may come, the declaration
// says when and where you are landing. It asks for much of what the visa
// application already asked, plus the flight and where you are staying, so the
// record that filled the application fills most of this too.
//
// What is settled here is the shape of the declaration and where each value
// comes from. The site puts a captcha in front of the form itself, before any
// field is drawn, so the selectors cannot be read from the page without a
// person solving that captcha first. Driving the form is therefore left until
// the visas are granted and a real declaration can be filed; until then this
// maps the data, says what is missing, and holds the entry points.

/** The site, and the three things it offers. */
export const PREARRIVAL_URL = 'https://prearrival.immigration.gov.vn';

export const ENTRY_POINTS = {
  submit: 'Create & Submit Pre-arrival Information',
  lookup: 'Lookup & Update Declaration',
  epass: 'Lookup E-Pass Information',
};

/**
 * The declaration's fields, in the order the filed copy prints them.
 *
 * `from` names the key on an applicant record that supplies the value, so a
 * traveller already described for the visa needs only what the visa never
 * asked. A field with no `from` has no source yet and must be supplied.
 */
export const PREARRIVAL_FIELDS = [
  // Lead passenger: all of this the visa application already holds.
  { key: 'fullName', label: 'Full Name', from: 'fullName', group: 'passenger' },
  { key: 'gender', label: 'Gender', from: 'sex', group: 'passenger' },
  {
    key: 'dateOfBirth',
    label: 'Date of Birth',
    from: 'dateOfBirth',
    group: 'passenger',
  },
  {
    key: 'nationality',
    label: 'Nationality',
    from: 'nationality',
    group: 'passenger',
  },
  {
    key: 'passportNumber',
    label: 'Passport Number',
    from: 'passportNumber',
    group: 'passenger',
  },
  {
    key: 'passportExpiryDate',
    label: 'Date of Expiry',
    from: 'passportExpiryDate',
    group: 'passenger',
  },
  { key: 'email', label: 'Email Address', from: 'email', group: 'passenger' },
  { key: 'phone', label: 'Phone Number', from: 'phone', group: 'passenger' },

  // The visa: read from the granted e-visa, and known from nowhere else.
  {
    key: 'visaType',
    label: 'Visa Type',
    fixed: 'Electronic Visa (E-Visa)',
    group: 'visa',
  },
  { key: 'visaNumber', label: 'Number', group: 'visa' },
  { key: 'visaIssueDate', label: 'Visa Issue Date', group: 'visa' },
  { key: 'visaExpiryDate', label: 'Visa Expiry Date', group: 'visa' },
  {
    key: 'visaIssuedPlace',
    label: 'Issued Place',
    fixed: 'Vietnam Immigration Department - Ministry of Public Security',
    group: 'visa',
  },

  // The trip: the entry date the visa was applied for, and the flight.
  {
    key: 'arrivalDate',
    label: 'Expected Arrival Date',
    from: 'entryDate',
    group: 'trip',
  },
  {
    key: 'departedFrom',
    label: 'First Point of Departure if Transiting Through Multiple country',
    group: 'trip',
  },
  {
    key: 'purpose',
    label: 'Purpose of Travel',
    from: 'purpose',
    group: 'trip',
  },
  {
    key: 'departureDate',
    label: 'Date of departure from Vietnam',
    group: 'trip',
  },
  { key: 'modeOfTravel', label: 'Mode of Travel', fixed: 'Air', group: 'trip' },
  {
    key: 'borderGate',
    label: 'Border Gate',
    from: 'entryGate',
    group: 'trip',
  },
  {
    key: 'vehicleNumber',
    label: 'Vehicle identification number',
    group: 'trip',
  },
  {
    key: 'accommodationType',
    label: 'Type of Accommodation in Vietnam',
    group: 'trip',
  },
  {
    key: 'accommodationAddress',
    label: 'Accommodation Address',
    from: 'addressInVietnam',
    group: 'trip',
  },
];

/**
 * The value a field takes, or null when nothing supplies it.
 *
 * A fixed value is the same for every e-visa traveller and is filled in
 * without asking; everything else comes from the record or from the extras
 * a caller passes for this particular trip.
 */
export function valueFor(field, applicant = {}, extras = {}) {
  if (
    extras[field.key] !== null &&
    extras[field.key] !== undefined &&
    extras[field.key] !== ''
  ) {
    return extras[field.key];
  }
  if (field.fixed) {
    return field.fixed;
  }
  if (
    field.from &&
    applicant[field.from] !== null &&
    applicant[field.from] !== undefined
  ) {
    return applicant[field.from];
  }
  return null;
}

/**
 * Builds the declaration from what is known, and says what is still missing.
 *
 * The flight and the hotel are the usual gaps, since the visa application
 * asks for neither, so they are the questions to put to the traveller.
 */
export function buildDeclaration(applicant = {}, extras = {}) {
  const values = {};
  const missing = [];
  for (const field of PREARRIVAL_FIELDS) {
    const value = valueFor(field, applicant, extras);
    if (value === null || value === undefined || value === '') {
      missing.push(field.key);
      continue;
    }
    values[field.key] = value;
  }
  return { values, missing };
}

/**
 * The traveller's name as the declaration wants it: one field, surname first,
 * matching the passport.
 */
export function fullNameOf(applicant = {}) {
  const parts = [applicant.surname, applicant.givenName].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

/**
 * What the declaration needs from the granted visa.
 *
 * These four are on the e-visa itself and nowhere else, so a declaration
 * cannot be completed before the visa is in hand.
 */
export const VISA_FIELDS = [
  'visaNumber',
  'visaIssueDate',
  'visaExpiryDate',
  'arrivalDate',
];

/** Whether everything the granted visa supplies is present. */
export function hasVisaDetails(values = {}) {
  return VISA_FIELDS.every(
    (key) =>
      values[key] !== null && values[key] !== undefined && values[key] !== ''
  );
}
