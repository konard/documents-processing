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
  registerArrivalCommand,
  showDeclaration,
} from '../src/evisa-prearrival.mjs';
import {
  arrivalDateOverride,
  declarationFor,
  tripFrom,
} from '../src/evisa-arrival-run.mjs';
import { MESSAGES } from '../src/evisa-messages.mjs';
import { noteDocumentIssue } from '../src/evisa-document-feedback.mjs';

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
  entryDate: '[REDACTED]',
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
    expect(values.arrivalDate).toBe('[REDACTED]');
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

describe('the trip page from documents already sent', () => {
  it('does not invent trip facts the documents do not state', () => {
    // The arrival flow receives a passport, a granted visa and an inbound
    // ticket. Those documents name the origin airport and the visa window,
    // but no hotel was sent and the ticket has no return leg. A visa expiry
    // is not a planned departure and an address does not prove
    // whether the traveller is in a hotel, a home or another kind of stay.
    const trip = tripFrom({
      vehicleNumber: '[REDACTED]',
      departedFrom: 'GOA MOPA AIRPORT',
      purpose: 'Tourist',
      visaExpiryDate: '[REDACTED]',
    });
    expect(trip).toEqual({
      modeOfTravel: 'Air',
      vehicleNumber: '[REDACTED]',
      departedFrom: 'India',
      purpose: 'Tourist',
      accommodationType: null,
      province: 'HO CHI MINH',
      ward: 'TAN BINH',
      accommodationAddress: '[REDACTED]',
      workplace: null,
      departureDate: null,
    });
  });

  it('prefers trip details the traveller supplied over defaults', () => {
    const applicant = {
      modeOfTravel: 'Sea',
      departedFrom: 'Thailand',
      accommodationType: 'Residential',
      province: 'Khanh Hoa Province',
      ward: 'Nha Trang Ward',
      accommodationAddress: '25/7 Tran Phu, Nha Trang',
      addressInVietnam: '[REDACTED]',
      departureDate: '[REDACTED]',
      visaExpiryDate: '[REDACTED]',
    };
    // This is the production call shape: the generic declaration supplies
    // defaults too, but the traveller's explicit trip details must win.
    const trip = tripFrom(applicant, buildDeclaration(applicant).values);
    expect(trip.modeOfTravel).toBe('Sea');
    expect(trip.departedFrom).toBe('Thailand');
    expect(trip.accommodationType).toBe('Residential');
    expect(trip.province).toBe('Khanh Hoa');
    expect(trip.ward).toBe('Nha Trang');
    expect(trip.accommodationAddress).toBe('25/7 Tran Phu, Nha Trang');
    expect(trip.departureDate).toBe('[REDACTED]');
  });

  it('takes the province and ward from a booking address', () => {
    const trip = tripFrom({
      accommodationAddress: '25/7 Tran Phu, Vinh Hai Ward, Нячанг, Вьетнам',
    });
    expect(trip.province).toBe('KHANH HOA');
    expect(trip.ward).toBe('VINH HAI');
    expect(trip.accommodationAddress).toBe(
      '25/7 Tran Phu, Vinh Hai Ward, Nha Trang'
    );
  });

  it('keeps a new booking address separate from the old e-visa stay', () => {
    const applicant = {
      accommodationAddress: '25/7 Tran Phu, Vinh Hai Ward, Нячанг, Вьетнам',
      addressInVietnam: '[REDACTED]',
      provinceInVietnam: 'HO CHI MINH City',
      wardInVietnam: 'PHUONG TAN BINH',
    };
    const trip = tripFrom(applicant, buildDeclaration(applicant).values);
    expect(trip.province).toBe('KHANH HOA');
    expect(trip.ward).toBe('VINH HAI');
    expect(trip.accommodationAddress).toBe(
      '25/7 Tran Phu, Vinh Hai Ward, Nha Trang'
    );
  });

  it('does not mix a partial supplied stay with an unrelated default', () => {
    const trip = tripFrom({
      provinceInVietnam: 'Khanh Hoa Province',
      wardInVietnam: 'Nha Trang Ward',
    });
    expect(trip.province).toBe('Khanh Hoa');
    expect(trip.ward).toBe('Nha Trang');
    expect(trip.accommodationAddress).toBe(null);
  });

  it('treats blank document fields as missing without guessing', () => {
    const trip = tripFrom({
      purpose: '',
      accommodationType: '',
      accommodationAddress: '',
      departureDate: '',
      visaExpiryDate: '[REDACTED]',
    });
    expect(trip.purpose).toBe('Tourist');
    expect(trip.accommodationType).toBe(null);
    expect(trip.province).toBe('HO CHI MINH');
    expect(trip.ward).toBe('TAN BINH');
    expect(trip.accommodationAddress).toBe(
      '[REDACTED]'
    );
    expect(trip.departureDate).toBe(null);
  });
});

describe('describing a trip page in the chat', () => {
  it('uses traveller-facing labels and hides browser implementation errors', async () => {
    const { describeFilled } = await import('../src/evisa-bot.mjs');
    const said = describeFilled(
      { modeOfTravel: 'Air' },
      {
        missing: ['province', 'ward'],
        failed: [
          'departedFrom: locator.waitFor: Timeout 10000ms exceeded.',
          'phoneCountryCode: selection was redrawn',
        ],
      },
      'ru'
    );
    expect(said.includes('вид транспорта: Air')).toBe(true);
    expect(said.includes('город или провинция проживания')).toBe(true);
    expect(said.includes('район или коммуна проживания')).toBe(true);
    expect(said.includes('откуда летите')).toBe(true);
    expect(said.includes('телефонный код страны')).toBe(true);
    for (const implementationDetail of [
      'province',
      'ward',
      'departedFrom',
      'phoneCountryCode',
      'locator.waitFor',
      'Timeout 10000ms',
    ]) {
      expect(said.includes(implementationDetail)).toBe(false);
    }
    expect(said.includes('Страница ещё не заполнена')).toBe(true);
    expect(said.includes('Форма заполнена и ждёт')).toBe(false);
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
    const shut = windowOpensOn('[REDACTED]', sept(12));
    expect(shut.opens).toBe('14/09/2026');
    expect(shut.days).toBe(2);
  });

  it('says nothing while the window is open', () => {
    // On the day it opens there is nothing to wait for, and on the day of the
    // flight itself there is nothing to wait for either.
    expect(windowOpensOn('[REDACTED]', sept(14))).toBe(null);
    expect(windowOpensOn('[REDACTED]', sept(16))).toBe(null);
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

describe('the rehearsal that fills the form for a day the site offers', () => {
  it('takes a date only from the setting meant for it', () => {
    expect(
      arrivalDateOverride({ EVISA_ARRIVAL_DATE_OVERRIDE: '14/09/2026' })
    ).toBe('14/09/2026');
  });

  it('is off when nothing sets it', () => {
    // The real filing is the default. A rehearsal has to be asked for.
    expect(arrivalDateOverride({})).toBe(null);
    expect(arrivalDateOverride({ EVISA_ARRIVAL_DATE_OVERRIDE: '' })).toBe(null);
  });

  it('refuses a date it cannot read as a day', () => {
    // A malformed setting must not become an arrival date on a government
    // form. Anything but DD/MM/YYYY leaves the traveller's own date alone.
    for (const said of ['tomorrow', '14-09-2026', '2026-09-14', '14/9/26']) {
      expect(
        `${said}:${arrivalDateOverride({ EVISA_ARRIVAL_DATE_OVERRIDE: said })}`
      ).toBe(`${said}:null`);
    }
  });

  it('leaves the ticket alone when no rehearsal is asked for', () => {
    const said = [];
    const session = {
      data: { surname: 'TRAVELLER', entryDate: '[REDACTED]' },
    };
    const { values, rehearsal } = declarationFor(session, {
      log: (chatId, line) => said.push(line),
      chatId: 1,
    });
    expect(rehearsal).toBe(null);
    // Without the setting the ticket's own date stands.
    expect(values.arrivalDate).toBe('[REDACTED]');
    expect(said).toEqual([]);
  });

  it('replaces the arrival date and says so in the log', () => {
    // The bot is driving a government form with a date the traveller is not
    // flying on. Every such fill leaves a line saying so, naming both dates,
    // so a rehearsal cannot be read back later as a real declaration.
    const said = [];
    process.env.EVISA_ARRIVAL_DATE_OVERRIDE = '14/09/2026';
    try {
      const { values, applicant, rehearsal } = declarationFor(
        { data: { surname: 'TRAVELLER', entryDate: '[REDACTED]' } },
        { log: (chatId, line) => said.push(line), chatId: 1 }
      );
      expect(rehearsal).toBe('14/09/2026');
      expect(values.arrivalDate).toBe('14/09/2026');
      expect(applicant.arrivalDate).toBe('14/09/2026');
      expect(said.length).toBe(1);
      expect(said[0].includes('REHEARSAL')).toBe(true);
      expect(said[0].includes('14/09/2026')).toBe(true);
      expect(said[0].includes('[REDACTED]')).toBe(true);
    } finally {
      delete process.env.EVISA_ARRIVAL_DATE_OVERRIDE;
    }
  });
});

describe('asked for the arrival card, the bot goes and gets it', () => {
  /** A bot that records the commands registered on it. */
  function fakeBot() {
    const handlers = new Map();
    return {
      handlers,
      command: (name, run) => {
        for (const one of [].concat(name)) {
          handlers.set(one, run);
        }
      },
    };
  }

  it('fills the form on /arrival, without a second command', async () => {
    // Showing what is known and then waiting for a command nobody mentioned
    // is asking a question, which is the one thing this bot does not do.
    const filled = [];
    const replies = [];
    const bot = fakeBot();
    registerArrivalCommand(bot, {
      sessions: {
        get: () => ({
          language: 'en',
          data: { entryDate: '14/09/2026', nationality: 'Russia' },
        }),
      },
      log: () => {},
      touch: () => {},
      describeDeclaration: () => 'the declaration',
      MESSAGES: { en: { arrivalIntro: 'the rule' } },
      fillArrival: (ctx, chatId) => filled.push(chatId),
    });
    await bot.handlers.get('arrival')({
      chat: { id: 7 },
      reply: async (text) => replies.push(text),
    });
    expect(filled).toEqual([7]);
    // Nothing said yet. The browser is opening and a captcha is coming, and
    // what is still wanted goes out with the news that the captcha is behind
    // us — at the moment the traveller can act on it, in one message rather
    // than one now and another a minute later saying the same thing.
    expect(replies).toEqual([]);
  });

  it('opens nothing when the site will not take the declaration yet', async () => {
    // A browser and a captcha spent to be told what the ticket already said.
    const filled = [];
    const bot = fakeBot();
    registerArrivalCommand(bot, {
      sessions: {
        get: () => ({ language: 'en', data: { entryDate: '31/12/2030' } }),
      },
      log: () => {},
      touch: () => {},
      describeDeclaration: () => 'the declaration',
      MESSAGES: {
        en: { arrivalIntro: 'the rule', arrivalWindowShut: () => 'not yet' },
      },
      fillArrival: (ctx, chatId) => filled.push(chatId),
    });
    await bot.handlers.get('arrival')({
      chat: { id: 7 },
      reply: async () => {},
    });
    expect(filled).toEqual([]);
  });

  it('answers /fill_arrival the same way', async () => {
    const bot = fakeBot();
    registerArrivalCommand(bot, {
      sessions: { get: () => ({ language: 'en', data: {} }) },
      log: () => {},
      touch: () => {},
      describeDeclaration: () => 'the declaration',
      MESSAGES: { en: { arrivalIntro: 'the rule' } },
      fillArrival: () => {},
    });
    expect(typeof bot.handlers.get('fill_arrival')).toBe('function');
    expect(typeof bot.handlers.get('arrival')).toBe('function');
  });

  it('forgets the last declaration before it begins another', async () => {
    // A declaration is about one arrival. Values carried over would go onto
    // the form with nobody having sent them, and a traveller who sends a new
    // passport and reads back an old number cannot tell which of their
    // documents the bot is working from.
    const forgotten = [];
    const bot = fakeBot();
    registerArrivalCommand(bot, {
      sessions: { get: () => ({ language: 'en', data: {} }) },
      log: () => {},
      touch: () => {},
      describeDeclaration: () => 'the declaration',
      MESSAGES: { en: { arrivalIntro: 'the rule' } },
      fillArrival: () => {},
      forget: (chatId) => forgotten.push(chatId),
    });
    await bot.handlers.get('arrival')({
      chat: { id: 7 },
      reply: async () => {},
    });
    expect(forgotten).toEqual([7]);
  });

  it('forgets before it reads what is known, not after', async () => {
    // Cleared after the values were gathered, the declaration would be built
    // from the very data the command is meant to drop.
    const order = [];
    const bot = fakeBot();
    registerArrivalCommand(bot, {
      sessions: {
        get: () => {
          order.push('read');
          return { language: 'en', data: {} };
        },
      },
      log: () => {},
      touch: () => {},
      describeDeclaration: () => 'the declaration',
      MESSAGES: { en: { arrivalIntro: 'the rule' } },
      fillArrival: () => {},
      forget: () => order.push('forget'),
    });
    await bot.handlers.get('arrival')({
      chat: { id: 7 },
      reply: async () => {},
    });
    expect(order[0]).toBe('forget');
  });

  it('says the rule, the values and the wait in one message', async () => {
    // Three notifications in a row for one command is three interruptions
    // for no more information than one carries.
    const replies = [];
    const bot = fakeBot();
    registerArrivalCommand(bot, {
      sessions: {
        get: () => ({ language: 'en', data: { entryDate: '31/12/2030' } }),
      },
      log: () => {},
      touch: () => {},
      describeDeclaration: () => 'the declaration',
      MESSAGES: {
        en: { arrivalIntro: 'the rule', arrivalWindowShut: () => 'not yet' },
      },
      fillArrival: () => {},
    });
    await bot.handlers.get('arrival')({
      chat: { id: 7 },
      reply: async (text) => replies.push(text),
    });
    expect(replies.length).toBe(1);
    for (const said of ['the rule', 'the declaration', 'not yet']) {
      expect(replies[0].includes(said)).toBe(true);
    }
  });
});

describe('the one answer while the declaration window is closed', () => {
  it('includes the batch document warnings and retires only those sent', async () => {
    const session = {
      language: 'en',
      data: { entryDate: '31/12/2030' },
    };
    noteDocumentIssue(session, 'downloadFailed');
    const replies = [];

    await showDeclaration({
      ctx: {
        reply: async (text) => {
          replies.push(text);
          noteDocumentIssue(session, 'unknownImage');
        },
      },
      session,
      MESSAGES,
      describeDeclaration: () => 'the declaration',
      intro: true,
    });

    expect(replies.length).toBe(1);
    expect(replies[0]).toContain('did not download');
    expect(replies[0]).not.toContain('not identified or used');
    expect(session.documentIssues).toEqual({ unknownImage: 1 });
  });

  it('restores document warnings when the one answer cannot be delivered', async () => {
    const session = { language: 'en', data: {} };
    noteDocumentIssue(session, 'downloadFailed');

    let failure = null;
    try {
      await showDeclaration({
        ctx: { reply: async () => Promise.reject(new Error('offline')) },
        session,
        MESSAGES,
        describeDeclaration: () => 'the declaration',
      });
    } catch (error) {
      failure = error;
    }

    expect(failure?.message).toBe('offline');
    expect(session.documentIssues).toEqual({ downloadFailed: 1 });
  });
});

describe('the browser opens on the word, not on the record', () => {
  /** Registers the command and returns its handlers. */
  function register(data, fillArrival) {
    const handlers = new Map();
    registerArrivalCommand(
      {
        command: (n, run) => [].concat(n).forEach((o) => handlers.set(o, run)),
      },
      {
        sessions: { get: () => ({ language: 'en', data }) },
        log: () => {},
        touch: () => {},
        describeDeclaration: () => 'the declaration',
        MESSAGES: { en: { arrivalIntro: 'the rule' } },
        fillArrival,
      }
    );
    return handlers;
  }

  it('opens the browser even with nothing to fill it with', async () => {
    // Opening the site and reading captchas until one is accepted takes the
    // better part of a minute, and the documents are usually still arriving
    // while it happens. Held back until the record looked complete, the same
    // work left a chat with no window and nothing happening — which is a bot
    // that has died as far as anyone watching can tell.
    const opened = [];
    const handlers = register({ entryDate: '14/09/2026' }, (ctx, chatId) =>
      opened.push(chatId)
    );
    await handlers.get('arrival')({ chat: { id: 7 }, reply: async () => {} });
    expect(opened).toEqual([7]);
  });

  it('opens it when the record is complete too', async () => {
    const opened = [];
    const handlers = register(
      { entryDate: '14/09/2026', nationality: 'Russia' },
      (ctx, chatId) => opened.push(chatId)
    );
    await handlers.get('arrival')({ chat: { id: 7 }, reply: async () => {} });
    expect(opened).toEqual([7]);
  });
});
