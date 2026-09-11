#!/usr/bin/env node
// evisa-bot.mjs
//
// A Telegram bot that collects what a Vietnam e-visa application needs, in
// Russian or English, and shows the applicant the filled form.
//
// Documents and the values read from them are held while the application is
// being prepared, and kept afterwards for diagnosis; evisa-log describes what
// is written where, and clears it on a schedule.
//
// Which fields are required is read from the live form, so a change on the
// government side surfaces as a question to the applicant.
//
// Usage:
//   EVISA_BOT_TOKEN=... node src/evisa-bot.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  looksLikeAddress,
  stripAddressLabel,
  stripAddressNote,
} from './evisa-home-address.mjs';
import { PREARRIVAL_FIELDS as PREARRIVAL_ORDER } from './evisa-prearrival.mjs';
import { canonicalBorderGate } from './evisa-data.mjs';
import { BORDER_GATES } from './evisa-schema.mjs';
import { MESSAGES, FIELD_PROMPTS } from './evisa-messages.mjs';

/**
 * How long a chat may go quiet before the bot fills the form on its own.
 *
 * Enough for the next of several messages sent together to arrive, and not
 * more: the fill is the answer, and nothing else is said until it is done.
 * The filled form is checked in the browser, and Next is only pressed on
 * the applicant's word, so the fill itself is safe to run without asking.
 */
export const IDLE_FILL_MS = 20_000;

/**
 * How long the bot waits between the applicant's word to send and pressing
 * Next: time to say "стой" after all. The one countdown in the conversation,
 * since this is the one step that is hard to take back.
 */
export const SEND_COUNTDOWN_MS = 30_000;

/**
 * How long a chat's browser is kept after its last message.
 *
 * A browser holds the filled form, so an applicant who comes back an hour
 * later finds it as they left it. One that nobody has touched for five
 * hours is not coming back, and each one open costs memory.
 */
export const CHAT_TTL_MS = 5 * 60 * 60 * 1000;

// What the bot says lives in its own module.
export { MESSAGES, FIELD_PROMPTS } from './evisa-messages.mjs';

/**
 * Field names for a list of values, where a prompt's wording would not read:
 * "your surname: DOE" and "фамилию: DOE" are questions, not labels. Only the
 * fields whose prompt does not serve as a label are here.
 */
export const FIELD_LABELS = {
  en: {
    surname: 'surname',
    givenName: 'given names',
    dateOfBirth: 'date of birth',
    sex: 'sex',
    nationality: 'nationality',
    email: 'email',
    religion: 'religion',
    placeOfBirth: 'place of birth',
    passportNumber: 'passport number',
    passportType: 'passport type',
    passportIssueDate: 'passport issued on',
    passportExpiryDate: 'passport expires on',
    passportIssuingAuthority: 'passport issued by',
    permanentAddress: 'permanent address',
    contactAddress: 'contact address',
    phone: 'phone',
    emergencyName: 'name',
    emergencyAddress: 'address',
    emergencyPhone: 'phone',
    emergencyRelationship: 'relationship',
    purpose: 'purpose',
    validFrom: 'visa valid from',
    validTo: 'visa valid to',
    entryDate: 'entry date',
    stayLengthDays: 'days of stay',
    addressInVietnam: 'address in Viet Nam',
    provinceInVietnam: 'province or city',
    wardInVietnam: 'ward or commune',
    entryBorderGate: 'entering through',
    exitBorderGate: 'leaving through',
  },
  ru: {
    surname: 'фамилия',
    givenName: 'имя и отчество',
    dateOfBirth: 'дата рождения',
    sex: 'пол',
    nationality: 'гражданство',
    email: 'электронная почта',
    religion: 'вероисповедание',
    placeOfBirth: 'место рождения',
    passportNumber: 'номер паспорта',
    passportType: 'тип паспорта',
    passportIssueDate: 'дата выдачи',
    passportExpiryDate: 'действителен до',
    passportIssuingAuthority: 'кем выдан',
    permanentAddress: 'адрес регистрации',
    contactAddress: 'контактный адрес',
    phone: 'телефон',
    emergencyName: 'имя',
    emergencyAddress: 'адрес',
    emergencyPhone: 'телефон',
    emergencyRelationship: 'кем приходится',
    purpose: 'цель поездки',
    validFrom: 'виза с',
    validTo: 'виза по',
    entryDate: 'дата въезда',
    stayLengthDays: 'дней пребывания',
    addressInVietnam: 'адрес во Вьетнаме',
    provinceInVietnam: 'провинция или город',
    wardInVietnam: 'район или коммуна',
    entryBorderGate: 'въезд через',
    exitBorderGate: 'выезд через',
  },
};

/** The label for a field in a list of values. */
export function labelFor(key, language) {
  const labels = FIELD_LABELS[language] ?? FIELD_LABELS.en;
  const prompts = FIELD_PROMPTS[language] ?? FIELD_PROMPTS.en;
  return labels[key] ?? prompts[key] ?? key;
}

/** Words that tell the bot to fill the form now, without waiting. */
const CONFIRMATIONS =
  /^[^\p{L}\p{N}]*(?:подтверждаю|отправляй|отправляйте|отправь|отправьте|отправить|заполняй|заполни|готово|давай|поехали|confirm(?:ed)?|go|fill|send|submit|ok|okay|yes|да)[^\p{L}\p{N}]*$/iu;

/** True for a message that says "go ahead", in either language. */
export function isConfirmation(text) {
  return CONFIRMATIONS.test(String(text ?? '').trim());
}

/** Words that tell the bot not to fill: the applicant wants another look. */
const CANCELLATIONS =
  /^[^\p{L}\p{N}]*(?:стой|стоп|отмена|отменить|отмени|подожди|погоди|не\s+(?:отправляй|заполняй)|stop|cancel|wait|hold\s+on|don'?t)[^\p{L}\p{N}]*$/iu;

/**
 * True for an error that says the browser or its page has gone: Playwright
 * words it in a few ways, all of them "closed".
 */
export function browserHasGone(error) {
  return /(?:target|page|context|browser)[^.]*(?:has been |was )?closed/i.test(
    String(error?.message ?? error)
  );
}

/**
 * True for a message that is only a captcha code: the site's are six
 * letters and digits, and a code is never mistaken for a detail.
 */
export function looksLikeCaptcha(text) {
  return /^[A-Za-z0-9]{4,8}$/.test(String(text ?? '').trim());
}

/** True for a message that says "stop", in either language. */
export function isCancellation(text) {
  return CANCELLATIONS.test(String(text ?? '').trim());
}

/**
 * Picks a language from what the applicant wrote.
 *
 * Cyrillic means Russian; otherwise English. Telegram's own language setting is
 * used only when the message carries no letters to judge by.
 */
export function detectLanguage(text, telegramCode) {
  if (typeof text === 'string' && /[Ѐ-ӿ]/.test(text)) {
    return 'ru';
  }
  if (typeof text === 'string' && /[A-Za-z]/.test(text)) {
    return 'en';
  }
  return String(telegramCode ?? '').startsWith('ru') ? 'ru' : 'en';
}

/** Lists what is still needed, in the applicant's language. */
export function describeMissing(fields, language) {
  const prompts = FIELD_PROMPTS[language] ?? FIELD_PROMPTS.en;
  const lines = fields.map(
    (field) => `• ${prompts[field.name] ?? field.label ?? field.name}`
  );
  return `${MESSAGES[language].needed}\n${lines.join('\n')}`;
}

/**
 * Fields that need no question: mirrored from another answer, or given a
 * sensible default the applicant can change in the browser.
 */
export const NOT_ASKED = [
  'confirmEmail',
  'passportType',
  'religion',
  'purpose',
  'contactAddress',
  'entryBorderGate',
  'exitBorderGate',
  'provinceInVietnam',
  'validFrom',
  'validTo',
  'entryDate',
];

/** Fields a passport photo answers, so they are not asked for separately. */
export const FROM_PASSPORT = [
  'surname',
  'givenName',
  'dateOfBirth',
  'sex',
  'nationality',
  'passportNumber',
  'passportExpiryDate',
  'passportIssueDate',
  'placeOfBirth',
];

/** Groups the remaining details under the part of the trip they belong to. */
export const DETAIL_GROUPS = {
  en: {
    you: 'About you',
    trip: 'Your trip',
    contact: 'Contacts',
  },
  ru: {
    you: 'О вас',
    trip: 'Поездка',
    contact: 'Контакты',
  },
};

const GROUP_OF = {
  email: 'you',
  confirmEmail: 'you',
  religion: 'you',
  permanentAddress: 'you',
  contactAddress: 'you',
  phone: 'you',
  emergencyName: 'contact',
  emergencyAddress: 'contact',
  emergencyPhone: 'contact',
  emergencyRelationship: 'contact',
};

/**
 * The checklist shown at /start, as a single message.
 *
 * Everything a passport photo answers is listed under that photo, so an
 * applicant can see that sending one picture covers nine of the entries rather
 * than reading them as nine separate questions.
 */
export function describeChecklist(fields, language) {
  const strings = MESSAGES[language] ?? MESSAGES.en;
  const prompts = FIELD_PROMPTS[language] ?? FIELD_PROMPTS.en;
  const groups = DETAIL_GROUPS[language] ?? DETAIL_GROUPS.en;
  const name = (field) => prompts[field.name] ?? field.label ?? field.name;

  const parts = [strings.welcome, ''];

  parts.push(`${strings.checklistDocuments}:`);
  parts.push(`• ${prompts.passportPage} — ${strings.readFromPassport}`);
  parts.push(`• ${prompts.portraitPhoto}`);

  // Anything the passport answers is covered above.
  const remaining = fields.filter(
    (field) =>
      !FROM_PASSPORT.includes(field.name) &&
      !NOT_ASKED.includes(field.name) &&
      field.name !== 'passportPage' &&
      field.name !== 'portraitPhoto'
  );

  for (const [key, heading] of Object.entries(groups)) {
    const inGroup = remaining.filter(
      (field) => (GROUP_OF[field.name] ?? 'trip') === key
    );
    if (inGroup.length) {
      parts.push('', `${heading}:`);
      parts.push(...inGroup.map((field) => `• ${name(field)}`));
    }
  }

  parts.push('', strings.checklistFooter);
  return parts.join('\n');
}

/** What each of the declaration's fields is called, to the applicant. */
const ARRIVAL_LABELS = {
  en: {
    fullName: 'full name',
    gender: 'sex',
    dateOfBirth: 'date of birth',
    nationality: 'nationality',
    passportNumber: 'passport',
    passportExpiryDate: 'passport expires',
    email: 'email',
    phone: 'phone',
    visaType: 'visa type',
    visaNumber: 'visa number',
    visaIssueDate: 'visa issued',
    visaExpiryDate: 'visa expires',
    visaIssuedPlace: 'issued by',
    arrivalDate: 'arriving on',
    departedFrom: 'flying from',
    purpose: 'purpose',
    departureDate: 'leaving Viet Nam on',
    modeOfTravel: 'travelling by',
    borderGate: 'arriving at',
    vehicleNumber: 'flight number',
    accommodationType: 'staying in',
    accommodationAddress: 'address in Viet Nam',
  },
  ru: {
    fullName: 'имя и фамилия',
    gender: 'пол',
    dateOfBirth: 'дата рождения',
    nationality: 'гражданство',
    passportNumber: 'паспорт',
    passportExpiryDate: 'паспорт действует до',
    email: 'почта',
    phone: 'телефон',
    visaType: 'тип визы',
    visaNumber: 'номер визы',
    visaIssueDate: 'виза выдана',
    visaExpiryDate: 'виза действует до',
    visaIssuedPlace: 'кем выдана',
    arrivalDate: 'дата прилёта',
    departedFrom: 'откуда летите',
    purpose: 'цель поездки',
    departureDate: 'дата вылета из Вьетнама',
    modeOfTravel: 'вид транспорта',
    borderGate: 'пункт прибытия',
    vehicleNumber: 'номер рейса',
    accommodationType: 'где остановитесь',
    accommodationAddress: 'адрес во Вьетнаме',
  },
};

// The parts of the form are named where the parts themselves are defined.
export { sectionName } from './evisa-sections.mjs';

/** Fields where a hyphen the site refuses is worth remarking on. */
const HYPHEN_NOTED = ['surname', 'givenName', 'emergencyName'];

/** The three parts a pre-arrival declaration is printed in. */
const ARRIVAL_GROUPS = {
  en: { passenger: 'Passenger', visa: 'Visa', trip: 'Trip' },
  ru: { passenger: 'Пассажир', visa: 'Виза', trip: 'Поездка' },
};

/**
 * The pre-arrival declaration as it stands: what is known, and what is not.
 *
 * The visa's own details are the usual blank, since they exist only after a
 * grant, so a declaration read before then is mostly a list of what to come
 * back for.
 */
export function describeDeclaration(values, missing, language) {
  const strings = MESSAGES[language] ?? MESSAGES.en;
  const groups = ARRIVAL_GROUPS[language] ?? ARRIVAL_GROUPS.en;
  const labels = ARRIVAL_LABELS[language] ?? ARRIVAL_LABELS.en;
  const parts = [];
  for (const [key, heading] of Object.entries(groups)) {
    const lines = PREARRIVAL_ORDER.filter(
      (field) => field.group === key && values[field.key]
    ).map(
      (field) =>
        `• ${labels[field.key] ?? field.label}: ${escapeHtml(values[field.key])}`
    );
    if (lines.length) {
      parts.push(`<b>${heading}</b>`, ...lines, '');
    }
  }
  if (missing.length) {
    parts.push(`<b>${strings.arrivalMissing}</b>`);
    parts.push(...missing.map((key) => `• ${labels[key] ?? key}`));
  }
  return parts.join('\n').trim();
}

/** Telegram's limit on the caption under a file. */
const CAPTION_LIMIT = 1024;

/**
 * What closes the last message: the declarations, then what to do next.
 *
 * Both belong under the values they are about. Above forty lines of them the
 * request scrolls off the screen, and an instruction nobody can see is one
 * nobody can follow. The declarations come just before it, so the applicant
 * reads what was committed in their name and then what to do.
 */
export function describeTail(result, outstanding, language) {
  const strings = MESSAGES[language] ?? MESSAGES.en;
  const tail = [];
  if (result.declared?.ticked?.length) {
    tail.push(
      strings.declared(
        result.declared.ticked.map((key) => strings.declarations[key] ?? key)
      )
    );
  }
  if (!outstanding.length) {
    tail.push(strings.ready);
  }
  return tail.join('\n\n');
}

/**
 * Everything there is to say about a fill, as one text: the caption under
 * the captured page.
 *
 * One message, not four. How many fields went in; how the site's own reading
 * of the passport compared, since it asks the applicant to check those;
 * which declarations were ticked, since each is made in the applicant's
 * name; what could not be filled; and either what is still needed or that
 * the form waits for their word before Next is pressed.
 */
export function describeOutcome(result, outstanding, language) {
  const strings = MESSAGES[language] ?? MESSAGES.en;
  const parts = [strings.filled(result.filled.length)];

  if (result.agreed?.length) {
    parts.push(strings.siteAgreed(result.agreed.length));
  }
  // The declarations and what to do next close the summary that follows,
  // where they sit under the values they are about. Saying them here as well
  // would put them above a list long enough to scroll them off the screen.
  if (result.corrected?.length) {
    parts.push('', strings.siteCorrected);
    for (const change of result.corrected) {
      parts.push(
        `• ${labelFor(change.field, language)}: "${change.was}" → "${change.now}"`
      );
    }
  }
  const failures = result.failures ?? [];
  if (failures.length) {
    parts.push('');
    for (const failure of failures.slice(0, 5)) {
      parts.push(strings.failed(failure.field, failure.error.split('\n')[0]));
    }
  }
  if (outstanding.length) {
    parts.push('', describeMissing(outstanding, language), strings.thenAgain);
  }
  const text = parts.join('\n');
  return text.length > CAPTION_LIMIT
    ? `${text.slice(0, CAPTION_LIMIT - 1)}…`
    : text;
}

/**
 * What to say under the page captured after Next: that the site took the
 * page and which stage it shows now, or that it kept the page, with the
 * form's first few messages and whatever the site said in a dialog.
 */
/** What to say under a page that the site accepted and went on from. */
/**
 * The registration dialog as a few named lines.
 *
 * Its code is the one thing the applicant has to keep, so it goes first and
 * alone; what is beside it is what a later lookup asks for. Anything the
 * dialog holds that is neither is the site talking to itself.
 */
function describeRegistration(lines, strings) {
  const said = lines.join('\n');
  const code = said.match(/\bE\d{6}[A-Z]{3}\d+\b/)?.[0];
  const after = (label) =>
    said
      .match(new RegExp(`${label}\\s*:?\\s*\\n?\\s*(.+)`, 'i'))?.[1]
      ?.trim()
      .split(/\s/)[0] || null;
  const named = [
    [strings.registrationCode, code],
    [strings.registrationEmail, after('Email')],
    [strings.registrationBirth, after('Date of birth')],
    [strings.registrationPassport, after('Passport')],
  ];
  return named
    .filter(([, value]) => value)
    .map(([label, value]) => `• ${label}: <b>${escapeHtml(value)}</b>`);
}

function describeArrival(step, strings) {
  if (step.stage === 'declared') {
    // The dialog's own lines run together where the site's buttons sit —
    // "PrintConfirm" — and repeat what the applicant has already been shown.
    // What is worth keeping is the code and the details beside it, named.
    return [
      strings.applicationIn,
      '',
      ...describeRegistration(step.dialog?.lines ?? [], strings),
      '',
      strings.applicationInNext,
    ].join('\n');
  }
  if (step.stage === 'review' && step.empty) {
    return strings.reviewEmpty;
  }
  return strings.stepMoved(
    strings.stages[step.stage] ?? strings.stages.unknown
  );
}

export function describeStep(step, language) {
  const strings = MESSAGES[language] ?? MESSAGES.en;
  if (step.moved) {
    return describeArrival(step, strings);
  }
  const parts = [strings.stepKept];
  const errors = step.errors ?? [];
  const notices = step.notices ?? [];
  if (errors.length) {
    parts.push(
      strings.stepMessages(errors.length),
      '',
      ...errors.slice(0, 8).map((error) => `• ${error}`)
    );
  }
  for (const notice of notices) {
    parts.push(strings.siteSaid(notice));
  }
  const text = parts.join('\n');
  return text.length > CAPTION_LIMIT
    ? `${text.slice(0, CAPTION_LIMIT - 1)}…`
    : text;
}

/** The form's fields in groups, in the order a reader looks for them. */
export const SECTIONS = [
  [
    'applicant',
    [
      'surname',
      'givenName',
      'dateOfBirth',
      'sex',
      'nationality',
      'placeOfBirth',
      'religion',
    ],
  ],
  [
    'passport',
    [
      'passportNumber',
      'passportType',
      'passportIssueDate',
      'passportExpiryDate',
      'passportIssuingAuthority',
    ],
  ],
  ['contacts', ['email', 'phone', 'permanentAddress', 'contactAddress']],
  [
    'emergency',
    [
      'emergencyName',
      'emergencyRelationship',
      'emergencyPhone',
      'emergencyAddress',
    ],
  ],
  [
    'trip',
    [
      'purpose',
      'entryDate',
      'validFrom',
      'validTo',
      'stayLengthDays',
      'entryBorderGate',
      'exitBorderGate',
      'addressInVietnam',
      'provinceInVietnam',
      'wardInVietnam',
    ],
  ],
];

/** What a mirrored value follows from; true when that was given. */
function derivedFrom(key, supplied) {
  switch (key) {
    case 'contactAddress':
      return Boolean(supplied.permanentAddress);
    case 'validFrom':
      return Boolean(supplied.entryDate);
    case 'validTo':
      return true;
    default:
      return false;
  }
}

/** Makes a value safe inside Telegram HTML, where the titles are bold. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Reports everything the form was filled with, in one message, as Telegram
 * HTML: the explanation that follows the captured page.
 *
 * Forty values in one list are hard to check, so they are grouped the way
 * the form itself is: applicant, passport, contacts, emergency contact, trip.
 * A value the applicant did not give is marked, since it is a decision made
 * on their behalf that ends up on a government form. A value that follows
 * from one they did give, the contact address from the permanent one or the
 * visa's first day from the entry date, is marked with where it came from
 * instead, since calling it assumed would say their answer was ignored.
 * Everything on the form is listed, every time. The applicant is being asked
 * to check this form, and they cannot check what they cannot see.
 */
/**
 * Where a value came from, as far as the fill can tell: the site read it off
 * the passport and agreed with us, or read it differently and was overruled,
 * or read it when we had nothing of our own.
 *
 * The applicant is asked to check these against the passport itself, so it
 * has to be plain whose reading each one is.
 */
function whoReadIt(key, fill, strings) {
  const overruled = (fill.corrected ?? []).find(
    (change) => change.field === key
  );
  if (overruled) {
    return ` ${strings.overruledMark(escapeHtml(overruled.was))}`;
  }
  if ((fill.agreed ?? []).includes(key)) {
    return ` ${strings.agreedMark}`;
  }
  if ((fill.siteOnly ?? []).includes(key)) {
    return ` ${strings.siteOnlyMark}`;
  }
  return '';
}

export function describeSummary(
  applicant,
  supplied,
  language,
  disputed = {},
  { asked = null, fill = {} } = {}
) {
  const strings = MESSAGES[language] ?? MESSAGES.en;
  const prompts = FIELD_PROMPTS[language] ?? FIELD_PROMPTS.en;
  // On the form and worth naming: every value the applicant can check.
  const onForm = (key) => Boolean(applicant[key] && prompts[key]);
  let assumedAny = false;

  const sourceFor = (key) => whoReadIt(key, fill, strings);

  const markFor = (key) => {
    if (supplied[key]) {
      return '';
    }
    if (strings.derived[key] && derivedFrom(key, supplied)) {
      return ` ${strings.derived[key]}`;
    }
    assumedAny = true;
    return ` ${strings.assumedMark}`;
  };

  // A name the passport hyphenates goes on the form with a space, and the
  // line says so, since the applicant will look for the hyphen. Only names:
  // a date is written one way here and another in the passport, and saying
  // so tells the applicant nothing they need.
  const noteFor = (key) => {
    if (!HYPHEN_NOTED.includes(key)) {
      return '';
    }
    const given = String(supplied[key] ?? '');
    return given.includes('-') && !String(applicant[key]).includes('-')
      ? ` ${strings.hyphenNote(escapeHtml(given))}`
      : '';
  };
  // A field the passport's readers split on has no value yet: the line
  // names the readings and asks.
  const disputedLine = (key) =>
    `• ${labelFor(key, language)}: ${strings.disputedNote(
      disputed[key].map((value) => `<b>${escapeHtml(value)}</b>`)
    )}`;
  const blocks = SECTIONS.map(([section, keys]) => {
    const lines = keys
      .filter((key) => onForm(key) || (disputed[key] && !applicant[key]))
      .map((key) =>
        disputed[key] && !applicant[key]
          ? disputedLine(key)
          : `• ${labelFor(key, language)}${markFor(key)}: ${escapeHtml(applicant[key])}${noteFor(key)}${sourceFor(key)}`
      );
    if (!lines.length) {
      return null;
    }
    return [`<b>${strings.sections[section]}</b>`, ...lines].join('\n');
  });
  const shown = blocks.filter(Boolean);
  // A form with nothing on it at all still has to say what to do next.
  if (!shown.length) {
    return asked || null;
  }
  const parts = [strings.summary, '', shown.join('\n\n')];
  if (assumedAny) {
    parts.push('', strings.assumedNote);
  }
  // What the applicant is being asked to do goes last, under everything it
  // refers to. Above forty lines of values it is scrolled off the screen, and
  // an instruction they cannot see is one they cannot follow.
  if (asked) {
    parts.push('', asked);
  }
  return parts.join('\n');
}

/**
 * Pulls applicant details out of ordinary prose, in either language.
 *
 * This is deliberately forgiving: someone typing "паспорт 12 34 567890" or
 * "my flight lands on 5 December" should not have to learn a format.
 */
export function parseFreeText(text) {
  const found = {};
  if (typeof text !== 'string' || !text.trim()) {
    return found;
  }

  const email = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (email) {
    found.email = email[0];
  }

  // A passport number is a run of digits, possibly spaced in pairs.
  const passport = text.match(
    /(?:passport|паспорт)\D{0,12}((?:\d[\s-]?){8,10})/i
  );
  if (passport) {
    found.passportNumber = passport[1].replace(/[\s-]/g, '');
  }

  const days = text.match(/(\d{1,3})\s*(?:days?|дн(?:я|ей|ём)?|суток)/i);
  if (days) {
    found.stayLengthDays = days[1];
  }

  parseLines(text, found, email?.[0]);

  return found;
}

/** Words that say a phone, a name or an address belongs to the contact person. */
const CONTACT_WORDS =
  /контакт|contact|родствен|relative|экстрен|emergency|сестр|брат|мам|мать|отец|пап|муж|жен|друг|подруг|сын|доч|т[её]т[яеи]|дяд|бабушк|бабул|дедушк|дед[аеу]?\b|внук|внучк|племянни|кузен|кузин|двоюродн|партн[её]р|sister|brother|mother|father|husband|wife|son|daughter|friend|aunt|uncle|grand(?:mother|father|ma|pa|son|daughter)|niece|nephew|cousin|partner/i;

/** A line that opens the block about the contact person. */
const CONTACT_HEADING =
  /^(?:(?:экстренн\w*|emergency)\s+)?(?:контакт\w*(?:\s+лицо)?|contact(?:\s+person)?)\s*:\s*(.*)$/i;

/** How a relative is described, and the word the form gets for it. */
const RELATIONSHIPS = [
  // The longer words first: "grandmother" holds "mother", "внучка" "внук".
  [/бабушк|бабул|grandmother|grandma/i, 'Grandmother'],
  [/дедушк|дед[аеу]?\b|grandfather|grandpa/i, 'Grandfather'],
  [/внучк|granddaughter/i, 'Granddaughter'],
  [/внук|grandson/i, 'Grandson'],
  [/т[её]т[яеи]|aunt/i, 'Aunt'],
  [/дяд|uncle/i, 'Uncle'],
  [/племянниц|niece/i, 'Niece'],
  [/племянник|nephew/i, 'Nephew'],
  [/кузен|кузин|двоюродн|cousin/i, 'Cousin'],
  [/сестр|sister/i, 'Sister'],
  [/брат|brother/i, 'Brother'],
  [/мам|мать|mother/i, 'Mother'],
  [/отец|отц|пап|father/i, 'Father'],
  [/муж|husband/i, 'Husband'],
  [/жен|wife/i, 'Wife'],
  [/сын|son\b/i, 'Son'],
  [/доч|daughter/i, 'Daughter'],
  [/партн[её]р|partner/i, 'Partner'],
  [/друг|подруг|friend/i, 'Friend'],
  [/коллег|colleague/i, 'Colleague'],
  [/родствен|relative/i, 'Relative'],
];

/** Values people write with a label in front, in either language. */
const LABELLED = [
  [
    /(?:дата\s+выдачи|выдан\w*|date\s+of\s+issue|issued(?:\s+on)?)\s*:?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i,
    'passportIssueDate',
  ],
  [
    /(?:место\s+рождения|place\s+of\s+birth|born\s+in)\s*:?\s*([^,;\n]+)/i,
    'placeOfBirth',
  ],
  [
    /(?:орган|кем\s+выдан|authority|issued\s+by)\s*:?\s*([^,;\n]+)/i,
    'passportIssuingAuthority',
  ],
];

/** A short label ending in a colon, with whatever follows it on the line. */
const LABELLED_LINE = /^(\p{L}[\p{L} ]{0,30}?)\s*:\s*(.*)$/u;

/** A line that says when the applicant flies or enters. */
// "въезд" is often typed "вьезд", and the two are indistinguishable to a
// reader, so both hard and soft signs are accepted.
const GATE_WORDS =
  /\b(?:border gate|landport|land port|seaport|sea port|airport|checkpoint|погранпереход|пункт пропуска|аэропорт|порт)\b/i;

const ENTRY_WORDS =
  /билет|вылет|прил[её]т|в[ъь]езд|arriv|flight|entry|ticket|дата\s+вьезда/i;

/** Months by their opening letters, in Russian and English. */
const MONTH_STEMS = [
  /^(?:янв|jan)/i,
  /^(?:фев|feb)/i,
  /^(?:мар|mar)/i,
  /^(?:апр|apr)/i,
  /^(?:ма[йя]|may)/i,
  /^(?:июн|jun)/i,
  /^(?:июл|jul)/i,
  /^(?:авг|aug)/i,
  /^(?:сен|sep)/i,
  /^(?:окт|oct)/i,
  /^(?:ноя|nov)/i,
  /^(?:дек|dec)/i,
];

/** A date as people write it: "16 сентября 2026 года", "5 Oct 2026", "16.09.2026". */
const WRITTEN_DATE =
  /(\d{1,2})\s+(\p{L}{3,})\.?,?\s+(\d{4})|(\d{1,2})[./-](\d{1,2})[./-](\d{4})/u;

/** The relationship named in a piece of text, as the form words it. */
function relationshipIn(text) {
  return RELATIONSHIPS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/**
 * The date written in a line, as the form wants it, or null.
 *
 * A month written in words is unambiguous, so "16 сентября 2026" and
 * "16.09.2026" both give 16/09/2026.
 */
export function dateInLine(line) {
  const match = String(line ?? '').match(WRITTEN_DATE);
  if (!match) {
    return null;
  }
  const [, dayWord, monthWord, yearWord, day, month, year] = match;
  if (day) {
    return `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year}`;
  }
  const index = MONTH_STEMS.findIndex((stem) => stem.test(monthWord));
  if (index < 0) {
    return null;
  }
  const monthNumber = String(index + 1).padStart(2, '0');
  return `${dayWord.padStart(2, '0')}/${monthNumber}/${yearWord}`;
}

/**
 * Takes a gate a line names as both the way in and the way out, which is
 * what a single-entry visa means.
 */
function noteBorderGate(line, found) {
  const gate = borderGateInLine(line);
  if (gate) {
    found.entryBorderGate ??= gate;
    found.exitBorderGate ??= gate;
  }
}

/**
 * The border gate a line names, as the form's dropdown spells it.
 *
 * An applicant writes the gate the way the instruction page does, or the way
 * a search engine gave it: "Bo Y International Border Gate" for what the form
 * calls "Bo Y Landport". A line is only read as a gate when it resolves to
 * exactly one of the site's own options.
 */
export function borderGateInLine(line) {
  const text = String(line ?? '').trim();
  // A gate names a place and its kind, so a line with neither is not one.
  if (!GATE_WORDS.test(text) || text.length > 60) {
    return null;
  }
  const resolved = canonicalBorderGate(stripAddressLabel(text));
  return BORDER_GATES.includes(resolved) ? resolved : null;
}

/**
 * Reads a heading that opens the contact person's block.
 *
 * "Контакт:" and "Emergency contact:" open it by name; so does a relation on
 * its own, "Сестра:" or "Brother: John Smith", which also says who the
 * contact is. Whatever follows the colon is read as the first line of the
 * block.
 */
function openContactBlock(line, found) {
  const heading = line.match(CONTACT_HEADING);
  if (heading) {
    return heading[1].trim();
  }
  const labelled = line.match(LABELLED_LINE);
  if (!labelled) {
    return null;
  }
  const [, label, rest] = labelled;
  const relation = relationshipIn(label);
  if (!relation || label.trim().split(/\s+/).length > 2) {
    return null;
  }
  found.emergencyRelationship ??= relation;
  return rest.trim();
}

/** True for a line that is a person's name: two to four words of letters. */
function looksLikeName(line) {
  const words = line.trim().split(/\s+/);
  return (
    words.length >= 2 &&
    words.length <= 4 &&
    words.every((word) => /^\p{L}[\p{L}'-]*$/u.test(word)) &&
    !CONTACT_WORDS.test(line)
  );
}

/**
 * Puts each phone on a line where it belongs.
 *
 * The words before a phone say whose it is: "телефон сестры +7..." is the
 * contact's, a bare number is the applicant's. When the applicant already
 * has one, any other is the contact's, and the words before it name the
 * relation.
 */
function parsePhones(line, found, inContact) {
  const pattern = /\+\d[\d\s()-]{7,}\d/g;
  const matches = [...line.matchAll(pattern)];
  matches.forEach((match, index) => {
    const previous = matches[index - 1];
    const next = matches[index + 1];
    const before = line.slice(
      previous ? previous.index + previous[0].length : 0,
      match.index
    );
    // A relation may also follow the number in brackets: "+7... (brother)".
    // Only the brackets count: the rest of the line after a number is about
    // whatever comes next on it.
    const after = line.slice(match.index + match[0].length, next?.index);
    const bracketed = /^\s*\(([^)]*)\)/.exec(after)?.[1] ?? '';
    const number = match[0].replace(/[\s()-]/g, '');
    const theirs =
      inContact ||
      CONTACT_WORDS.test(before) ||
      CONTACT_WORDS.test(bracketed) ||
      found.phone;
    if (theirs) {
      found.emergencyPhone ??= number;
      const relation = relationshipIn(before) ?? relationshipIn(bracketed);
      if (relation) {
        found.emergencyRelationship ??= relation;
      }
    } else {
      found.phone = number;
    }
  });
  return line.replace(pattern, ' ');
}

/**
 * Reads a message line by line, keeping track of whether the lines belong
 * to the applicant or to the contact person.
 *
 * A heading such as "Контакт:" or "Сестра:" opens the contact's block, which
 * runs to the next blank line; a name, an address or a phone inside it is
 * theirs. A label on the line itself ("Контактный адрес:", "телефон сестры")
 * decides on its own. A line about the flight or the entry gives the entry
 * date. Everything else is the applicant's.
 */
function parseLines(text, found, email) {
  let inContact = false;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) {
      inContact = false;
      continue;
    }
    const opened = openContactBlock(line, found);
    if (opened !== null) {
      inContact = true;
      line = opened;
    }
    parseLabelled(line, found);
    const entry = ENTRY_WORDS.test(line) ? dateInLine(line) : null;
    if (entry) {
      found.entryDate ??= entry;
    }
    noteBorderGate(line, found);
    line = parsePhones(line, found, inContact);
    line = line
      .replace(email ?? /$^/, ' ')
      .replace(/[\s,;-]+$/, '')
      .trim();
    if (looksLikeAddress(line)) {
      const field = addressFieldFor(line, inContact);
      found[field] ??= stripAddressNote(stripAddressLabel(line));
    } else if (line && inContact && looksLikeName(line)) {
      found.emergencyName ??= line;
    }
  }
}

/** Takes the values written with a label out of a line. */
function parseLabelled(line, found) {
  for (const [pattern, field] of LABELLED) {
    const match = line.match(pattern);
    if (match) {
      found[field] ??= match[1].trim();
    }
  }
}

/** Which address field an address line is for, by its label or its block. */
function addressFieldFor(line, inContact) {
  const label = line.includes(':') ? line.slice(0, line.indexOf(':')) : '';
  if (inContact || /экстрен|emergency|контакт(?:ное)?\s+лицо/i.test(label)) {
    return 'emergencyAddress';
  }
  return /контакт|contact/i.test(label) ? 'contactAddress' : 'permanentAddress';
}

/**
 * Holds one chat's collected values in memory.
 *
 * Nothing here is written to disk. A chat's entry lives until /reset, or
 * until the chat has been quiet for the chat lifetime and its browser is
 * closed, so an applicant can add to a form for as long as they are at it.
 */
export function createSessionStore() {
  const sessions = new Map();
  return {
    get(chatId) {
      if (!sessions.has(chatId)) {
        sessions.set(chatId, {
          data: {},
          uploads: {},
          // What has been put on the page, so it is not uploaded again.
          uploaded: {},
          language: 'en',
          lastActivity: Date.now(),
        });
      }
      return sessions.get(chatId);
    },
    /** Every chat id with a session, for sweeps. */
    ids() {
      return [...sessions.keys()];
    },
    /**
     * Forgets an application, and keeps what is not part of one.
     *
     * The language is the applicant's own choice, made once and good for the
     * whole conversation: starting another application is no reason to
     * answer them in a language they did not ask for.
     */
    clear(chatId) {
      const kept = sessions.get(chatId)?.language;
      sessions.delete(chatId);
      if (kept) {
        this.get(chatId).language = kept;
      }
    },
    get size() {
      return sessions.size;
    },
  };
}

/**
 * Writes a downloaded document to a temporary file.
 *
 * With debugging on, the file is left in place: a bad crop or a bad read can
 * only be diagnosed against the image that produced it. That means received
 * documents accumulate under the system temp directory until they are cleared,
 * so `keep` is what the operator turns off to have them removed after reading.
 *
 * Telegram serves files over HTTPS and the OCR helpers need a path, so the
 * document touches disk either way.
 */
export async function withTempFile(
  buffer,
  extension,
  use,
  { keep = false } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-bot-'));
  const file = path.join(dir, `document${extension}`);
  fs.writeFileSync(file, buffer);
  try {
    return await use(file, dir);
  } finally {
    if (!keep) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
