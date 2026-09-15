import { describe, it, expect } from 'test-anywhere';
import {
  arrivalAnswerFor,
  arrivalConfirmationAction,
  sendArrivalAnswer,
} from '../src/evisa-arrival-run.mjs';
import { describeFilled } from '../src/evisa-bot.mjs';
import { MESSAGES } from '../src/evisa-messages.mjs';
import { noteDocumentIssue } from '../src/evisa-document-feedback.mjs';

class InputFile {
  constructor(bytes, name) {
    this.bytes = bytes;
    this.name = name;
  }
}

function capture(at, onThePage, result = {}) {
  return {
    at,
    title: ['Passenger Information', 'Trip Information', 'Review & Submit'][at],
    result: { filled: [], missing: [], failed: [], ...result },
    onThePage,
    shot: Buffer.from(`page-${at + 1}`),
  };
}

function answerFor(one, options = {}) {
  const session = options.session ?? { language: 'ru' };
  return arrivalAnswerFor({
    capture: one,
    session,
    strings: MESSAGES[session.language],
    describeFilled,
    ready: options.ready ?? true,
    refused: options.refused ?? [],
    rehearsal: options.rehearsal ?? '',
    tooEarly: options.tooEarly ?? null,
    expired: options.expired ?? false,
  });
}

describe('one readable answer for each arrival page', () => {
  it('shows only page 1 and puts its confirmation instruction last', () => {
    const answer = answerFor(
      capture(
        0,
        {
          fullName: 'TRAVELLER JORDAN',
          gender: 'Male',
          dateOfBirth: '[REDACTED]',
          nationality: 'Russian Federation',
          passportType: 'P - Popular Passport',
          passportNumber: '712345678',
          passportExpiryDate: '[REDACTED]',
          visaType: 'Electronic Visa (E-Visa)',
          visaNumber: '712345678',
          visaIssueDate: '[REDACTED]',
          visaExpiryDate: '[REDACTED]',
          visaIssuedPlace:
            'Vietnam Immigration Department - Ministry of Public Security',
          arrivalDate: '[REDACTED]',
          email: 'traveller@example.com',
          phone: '+12025550123',
        },
        { filled: ['passportImage', 'readTheNotes'] }
      )
    );

    expect(answer.shot.toString()).toBe('page-1');
    expect(answer.caption).toContain('Страница 1 из 3');
    expect(answer.caption).toContain('TRAVELLER JORDAN');
    expect(answer.caption).not.toContain('На странице 2 заполнено');
    expect(answer.caption).not.toContain('Страница 3 из 3');
    expect(answer.caption.endsWith(MESSAGES.ru.arrivalPageReady)).toBe(true);
    expect(answer.caption).toContain('<b>далее</b>');
    expect(answer.caption).toContain('текст или документ');
  });

  it('shows page 2 with the default stay filled and no optional departure warning', () => {
    const answer = answerFor(
      capture(1, {
        departedFrom: 'India',
        modeOfTravel: 'Air',
        vehicleNumber: '[REDACTED]',
        borderGate: 'SGN -  Tan Son Nhat International Airport',
        purpose: 'Travel',
        accommodationType: 'Hotel',
        province: 'Ho Chi Minh City',
        ward: 'Tan Binh Ward',
        accommodationAddress: '[REDACTED]',
      })
    );

    expect(answer.shot.toString()).toBe('page-2');
    expect(answer.caption).toContain('Страница 2 из 3');
    expect(answer.caption).toContain(
      'SGN - Tan Son Nhat International Airport'
    );
    expect(answer.caption).not.toContain('SGN -  Tan Son Nhat');
    expect(answer.caption).toContain('проживание: Hotel');
    expect(answer.caption).toContain('[REDACTED]');
    expect(answer.caption).not.toContain('где остановитесь');
    expect(answer.caption).not.toContain('дата вылета из Вьетнама');
    expect(answer.caption).not.toContain('Страница 1 заполнена');
    expect(answer.caption.endsWith(MESSAGES.ru.arrivalPageReady)).toBe(true);
  });

  it('puts the final submission warning at the very bottom of review', () => {
    const answer = answerFor(capture(2, {}));

    expect(answer.shot.toString()).toBe('page-3');
    expect(answer.caption).toContain('Страница 3 из 3');
    expect(answer.caption).not.toContain('Страница 1 заполнена');
    expect(answer.caption).not.toContain('На странице 2 заполнено');
    expect(answer.caption.endsWith(MESSAGES.ru.arrivalReviewReady)).toBe(true);
    expect(answer.caption).toContain('галочка не поставлена');
    expect(answer.caption).toContain('Submit не нажат');
  });

  it('keeps actionable failures on their own page and instructions last', () => {
    const answer = answerFor(
      capture(
        1,
        {
          modeOfTravel: 'Air',
          accommodationType: 'Hotel',
          province: 'Ho Chi Minh City',
          ward: 'Tan Binh Ward',
          accommodationAddress: '[REDACTED]',
        },
        {
          failed: ['departedFrom: locator.waitFor: Timeout 10000ms exceeded.'],
        }
      ),
      { ready: false }
    );

    expect(answer.caption).toContain('откуда летите');
    expect(answer.caption).not.toContain('locator.waitFor');
    expect(answer.caption).not.toContain('где остановитесь');
    expect(answer.caption).not.toContain('дата вылета из Вьетнама');
    expect(answer.caption.endsWith(MESSAGES.ru.arrivalPageIncomplete())).toBe(
      true
    );
  });

  it('never asks for missing data when a complete page merely stayed put', () => {
    const answer = answerFor(
      capture(1, {
        departedFrom: 'India',
        modeOfTravel: 'Air',
        vehicleNumber: '[REDACTED]',
        borderGate: 'SGN - Tan Son Nhat International Airport',
        purpose: 'Travel',
        accommodationType: 'Hotel',
        province: 'Ho Chi Minh City',
        ward: 'Tan Binh Ward',
        accommodationAddress: '[REDACTED]',
      }),
      { ready: false }
    );

    expect(answer.caption).toContain('Все обязательные поля заполнены');
    expect(answer.caption).not.toContain('Пришлите недостающее');
    expect(answer.caption).toContain('текст или документ');
  });

  it('distinguishes an unread uploaded passport from a failed upload', () => {
    const unread = answerFor(
      capture(
        0,
        {},
        {
          filled: ['passportImage'],
          failed: ['passportImage: the site read nothing from it'],
        }
      )
    );
    const failed = answerFor(
      capture(
        0,
        {},
        {
          failed: ['passportImage: file chooser rejected the upload'],
        }
      ),
      { ready: false }
    );

    expect(unread.caption).toContain(MESSAGES.ru.arrivalPassportUnread);
    expect(failed.caption).not.toContain(MESSAGES.ru.arrivalPassportUnread);
    expect(failed.caption).toContain('фото паспорта');
  });
});

describe('complete arrival warning captions', () => {
  it('keeps every known warning and the final instruction in one caption', () => {
    const session = { language: 'en' };
    for (const issue of [
      'downloadFailed',
      'compressedPhoto',
      'passportPageUncertain',
      'bookingWithoutAddress',
      'unknownImage',
    ]) {
      noteDocumentIssue(session, issue);
    }
    const answer = answerFor(
      capture(
        0,
        {
          fullName: 'TRAVELLER JORDAN ALEXANDER',
          gender: 'Male',
          dateOfBirth: '04/11/1988',
          nationality: 'Example Federation',
          passportType: 'P - Popular Passport',
          passportNumber: '712345678',
          passportExpiryDate: '09/09/2030',
          visaType: 'Electronic Visa (E-Visa)',
          visaNumber: '712345678',
          visaIssueDate: '01/09/2026',
          visaExpiryDate: '30/11/2026',
          visaIssuedPlace: 'Example Immigration Department',
          arrivalDate: '15/09/2026',
          email: 'traveller@example.com',
          phone: '+12025550123',
        },
        {
          filled: ['passportImage', 'readTheNotes'],
          failed: ['passportImage: the site read nothing from it'],
        }
      ),
      { session }
    );

    expect(answer.caption.length <= 1024).toBe(true);
    expect(answer.caption.endsWith(MESSAGES.en.arrivalPageReady)).toBe(true);
    for (const issue of Object.keys(session.documentIssues)) {
      expect(answer.caption).toContain(MESSAGES.en.documentIssues[issue](1));
    }
  });
});

describe('sending a declaration page', () => {
  it('sends exactly the supplied page and keeps the caption below it', async () => {
    const sent = [];
    const session = { language: 'en' };
    const answer = answerFor(capture(1, { accommodationType: 'Hotel' }), {
      session,
    });
    const ok = await sendArrivalAnswer({
      ctx: {
        reply: async (...args) => sent.push(['text', ...args]),
        replyWithPhoto: async (...args) => sent.push(['photo', ...args]),
      },
      chatId: 1,
      answer,
      session,
      strings: MESSAGES.en,
      InputFile,
      log: () => {},
    });

    expect(ok).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0][0]).toBe('photo');
    expect(sent[0][1].bytes.toString()).toBe('page-2');
    expect(sent[0][2].show_caption_above_media).toBe(false);
  });

  it('retires only warnings included before the send began', async () => {
    const session = { language: 'en' };
    noteDocumentIssue(session, 'downloadFailed');
    const answer = answerFor(capture(0, {}), { session });
    let deliver;
    const delivered = new Promise((resolve) => {
      deliver = resolve;
    });
    const sending = sendArrivalAnswer({
      ctx: { replyWithPhoto: () => delivered },
      chatId: 1,
      answer,
      session,
      strings: MESSAGES.en,
      InputFile,
      log: () => {},
    });
    noteDocumentIssue(session, 'unknownImage');
    deliver();

    expect(await sending).toBe(true);
    expect(session.documentIssues).toEqual({ unknownImage: 1 });
    expect(answer.caption).toContain('not a photo-quality error');
  });

  it('restores warnings when Telegram rejects the page', async () => {
    const session = { language: 'en' };
    noteDocumentIssue(session, 'downloadFailed');
    const sent = await sendArrivalAnswer({
      ctx: {
        replyWithPhoto: async () => Promise.reject(new Error('offline')),
      },
      chatId: 1,
      answer: answerFor(capture(0, {}), { session }),
      session,
      strings: MESSAGES.en,
      InputFile,
      log: () => {},
    });

    expect(sent).toBe(false);
    expect(session.documentIssues).toEqual({ downloadFailed: 1 });
  });

  it('keeps a screenshot when a pathological caption needs shortening', async () => {
    const sent = [];
    await sendArrivalAnswer({
      ctx: {
        replyWithPhoto: async (...args) => sent.push(args),
      },
      chatId: 1,
      answer: {
        caption: `<b>${'word '.repeat(300)}</b>\n\n${MESSAGES.en.arrivalPageReady}`,
        shot: Buffer.from('page'),
        instruction: MESSAGES.en.arrivalPageReady,
      },
      session: { language: 'en' },
      strings: MESSAGES.en,
      InputFile,
      log: () => {},
    });

    expect(sent.length).toBe(1);
    expect(sent[0][0].bytes.toString()).toBe('page');
    expect(sent[0][1].caption.length <= 1024).toBe(true);
    expect(sent[0][1].caption.endsWith('or a document.')).toBe(true);
  });
});

describe('arrival confirmations never fall through to the visa workflow', () => {
  it('advances one filled page at a time and files only from review', () => {
    expect(arrivalConfirmationAction(null)).toBe(null);
    expect(arrivalConfirmationAction({ stage: 'passenger' })).toBe('advance');
    expect(arrivalConfirmationAction({ stage: 'trip' })).toBe('advance');
    expect(arrivalConfirmationAction({ stage: 'review' })).toBe('file');
    expect(arrivalConfirmationAction({ stage: 'captcha' })).toBe('hold');
    expect(arrivalConfirmationAction({ stage: 'form' })).toBe('hold');
    expect(arrivalConfirmationAction({ stage: 'advancing' })).toBe('hold');
    expect(arrivalConfirmationAction({ stage: 'filed' })).toBe('hold');
  });
});
