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
//
// The /arrival command is here too, with the declaration it draws.

import { MODES, enterMode } from './evisa-mode.mjs';
import { ARRIVAL_WINDOW_DAYS } from './evisa-prearrival-form.mjs';

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
  {
    key: 'passportType',
    label: 'Passport Type',
    from: 'passportType',
    fixed: 'P - Popular Passport',
    group: 'passenger',
  },
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
  // A field with both a `fixed` value and a `from` takes the record's word
  // when it has one: the fixed value is what most travellers have, not what
  // all of them have. Read the other way round, a diplomatic passport would
  // be declared an ordinary one, which is a false statement to an
  // immigration department.
  if (
    field.from &&
    applicant[field.from] !== null &&
    applicant[field.from] !== undefined &&
    applicant[field.from] !== ''
  ) {
    return applicant[field.from];
  }
  if (field.fixed) {
    return field.fixed;
  }
  // A field the visa or the ticket supplies is kept under the name the
  // declaration itself uses, there being nothing on the application form to
  // map it from. Reading the e-visa is what fills these.
  if (applicant[field.key] !== null && applicant[field.key] !== undefined) {
    return applicant[field.key];
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
 * The day the site will begin taking a declaration for this arrival.
 *
 * The form offers the day of arrival and the two before it, counted in GMT+7,
 * so filing opens two days before landing. Knowing the traveller's own date
 * turns the rule into a date they can act on.
 *
 * `null` when the arrival is unknown or already inside the window: there is
 * nothing to wait for, and saying so would be noise.
 */
export function windowOpensOn(arrivalDate, today = nowInVietnam()) {
  const lands = dayFromDeclaration(arrivalDate);
  if (!lands) {
    return null;
  }
  const opens = lands - (ARRIVAL_WINDOW_DAYS - 1) * 86400000;
  if (opens <= today) {
    return null;
  }
  return { opens: asDeclarationDay(opens), days: (opens - today) / 86400000 };
}

/** Today in GMT+7, the timezone the site counts its three days in. */
export function nowInVietnam(at = Date.now()) {
  const there = new Date(at + 7 * 3600000);
  return Date.UTC(
    there.getUTCFullYear(),
    there.getUTCMonth(),
    there.getUTCDate()
  );
}

/** A DD/MM/YYYY day as a moment, or null when it is not one. */
function dayFromDeclaration(text) {
  const said = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(text ?? '').trim());
  if (!said) {
    return null;
  }
  return Date.UTC(Number(said[3]), Number(said[2]) - 1, Number(said[1]));
}

/** A moment back as the DD/MM/YYYY the declaration prints. */
function asDeclarationDay(at) {
  const day = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(day.getUTCDate())}/${pad(day.getUTCMonth() + 1)}/${day.getUTCFullYear()}`;
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

/**
 * Shows the declaration as it now stands, and what is still wanted for it.
 *
 * Run when the chat is asked for it and again whenever a document has added
 * to it. Reading a visa and a ticket in silence left the traveller looking
 * at the list of everything the declaration wanted, sent before either was
 * read, with no way to tell that most of it had just been answered.
 */
export async function showDeclaration({
  ctx,
  session,
  MESSAGES,
  describeDeclaration,
  intro = false,
}) {
  const applicant = {
    ...(session.data ?? {}),
    fullName: fullNameOf(session.data ?? {}),
  };
  const { values, missing } = buildDeclaration(applicant);
  const strings = MESSAGES[session.language];
  if (intro) {
    await ctx.reply(strings.arrivalIntro);
  }
  await ctx.reply(describeDeclaration(values, missing, session.language), {
    parse_mode: 'HTML',
  });
  // With the flight known, the rule becomes a date. A traveller who sends
  // every document they own deserves to hear why the form cannot be filled
  // yet. Given only a list of what is wanted, they are left to guess that
  // one of their documents failed to arrive.
  const shut = windowOpensOn(values.arrivalDate);
  if (shut) {
    await ctx.reply(
      strings.arrivalWindowShut(values.arrivalDate, shut.opens, shut.days)
    );
  }
  return { values, missing, shut };
}

/**
 * The answer a chat gives when documents arrive for the arrival card.
 *
 * Runs at the end of the quiet window, so four files forwarded together are
 * answered once, with everything they added between them.
 */
export function showArrival({ sessions, MESSAGES, describeDeclaration, log }) {
  return async function arrived(ctx, chatId) {
    const session = sessions.get(chatId);
    const { missing } = await showDeclaration({
      ctx,
      session,
      MESSAGES,
      describeDeclaration,
    });
    log(chatId, `declaration shown; ${missing.length} still wanted`);
  };
}

/**
 * Registers /arrival, which opens the declaration and asks for what it wants.
 *
 * The arrival card is a separate filing on a separate site, and the one thing
 * it shares with a visa application is the traveller. So its command belongs
 * with the declaration it draws, not among the visa commands.
 */
export function registerArrivalCommand(bot, deps) {
  const {
    sessions,
    log,
    touch,
    describeDeclaration,
    MESSAGES,
    // What language to answer in, which outlives a session and the bot. A
    // restart leaves a fresh session holding the default, so a command that
    // never reads the choice back answers a Russian chat in English.
    speakTheirLanguage = (chatId) => sessions.get(chatId).language,
    // Opening the site and driving it, which only the bot has a browser for.
    fillArrival = null,
  } = deps;

  bot.command('arrival', async (ctx) => {
    const chatId = ctx.chat.id;
    log(chatId, '/arrival');
    touch(chatId);
    const session = enterMode(sessions.get(chatId), MODES.arriving);
    session.language = speakTheirLanguage(chatId);
    await showDeclaration({
      ctx,
      session,
      MESSAGES,
      describeDeclaration,
      intro: true,
    });
  });

  // Showing the declaration and filling it in are separate asks. The first
  // costs nothing and answers from memory; the second opens a browser on a
  // government site and puts a captcha in front of the traveller, which is
  // not something to do to somebody who only wanted to see the list.
  if (!fillArrival) {
    return;
  }
  bot.command(['fill_arrival', 'fill-arrival'], async (ctx) => {
    const chatId = ctx.chat.id;
    log(chatId, '/fill_arrival');
    touch(chatId);
    const session = enterMode(sessions.get(chatId), MODES.arriving);
    session.language = speakTheirLanguage(chatId);
    // Answered from memory before any browser opens. The site would draw a
    // captcha, take the reading, and then offer three days that do not
    // include the flight — a minute of the traveller's attention spent to
    // be told something already known from the ticket.
    const { values } = buildDeclaration({
      ...(session.data ?? {}),
      fullName: fullNameOf(session.data ?? {}),
    });
    const shut = windowOpensOn(values.arrivalDate);
    if (shut) {
      log(chatId, `too early to file: the window opens on ${shut.opens}`);
      await ctx.reply(
        MESSAGES[session.language].arrivalWindowShut(
          values.arrivalDate,
          shut.opens,
          shut.days
        )
      );
      return;
    }
    await fillArrival(ctx, chatId);
  });
}
