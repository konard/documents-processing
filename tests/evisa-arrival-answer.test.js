import { describe, it, expect } from 'test-anywhere';
import {
  arrivalAnswerFor,
  combineArrivalScreenshots,
  sendArrivalAnswer,
  settleArrivalWalk,
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

describe('the one answer for a forwarded arrival batch', () => {
  it('sends every captured page as one image with a complete passenger check', async () => {
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
    const captured = [
      {
        at: 0,
        title: 'Passenger Information',
        result: {
          filled: [],
          missing: [],
          failed: ['passportImage: the site read nothing from it'],
        },
        onThePage: {
          fullName: 'TRAVELLER JORDAN ALEXANDER MAXIMILIAN',
          gender: 'Male',
          arrivalDate: '15/09/2026',
          phone: '+12025550123',
        },
        shot: Buffer.from('passenger'),
      },
      {
        at: 1,
        title: 'Trip Information',
        result: {
          filled: ['modeOfTravel', 'accommodationType'],
          missing: [],
          failed: [],
        },
        onThePage: {
          modeOfTravel: 'Air',
          accommodationType: 'Hotel',
          vehicleNumber: 'XX1234',
        },
        shot: Buffer.from('trip'),
      },
      {
        at: 2,
        title: 'Review & Submit',
        result: { filled: [], missing: [], failed: [] },
        onThePage: {},
        shot: Buffer.from('review'),
      },
    ];
    const answer = arrivalAnswerFor({
      walk: { reached: 2, pages: captured.map((one) => one.result) },
      captured,
      applicant: {},
      session,
      strings: MESSAGES.en,
      describeFilled,
    });

    for (const wanted of [
      'TRAVELLER JORDAN ALEXANDER MAXIMILIAN',
      'Male',
      '15/09/2026',
      '+12025550123',
      'XX1234',
      'Hotel',
      'could not reread the passport image',
      'not a photo-quality error',
    ]) {
      expect(answer.caption.includes(wanted)).toBe(true);
    }
    expect(answer.caption.length <= 1024).toBe(true);
    expect(answer.shot.toString()).toBe('review');
    expect(answer.shots.map((shot) => shot.toString())).toEqual([
      'passenger',
      'trip',
      'review',
    ]);

    const sent = [];
    const ctx = {
      reply: async (...args) => sent.push(['text', ...args]),
      replyWithPhoto: async (...args) => sent.push(['photo', ...args]),
    };
    expect(
      await sendArrivalAnswer({
        ctx,
        chatId: 1,
        answer,
        session,
        strings: MESSAGES.en,
        InputFile,
        log: () => {},
        combineScreenshots: async (shots) =>
          Buffer.from(shots.map((shot) => shot.toString()).join('+')),
      })
    ).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0][0]).toBe('photo');
    expect(sent[0][1].bytes.toString()).toBe('passenger+trip+review');
    expect(session.documentIssues).toBe(undefined);
  });
});

describe('a blocked forwarded arrival batch', () => {
  it('shows all visited pages with localised actionable fields', async () => {
    const session = { language: 'ru' };
    const failed = 'departedFrom: locator.waitFor: Timeout 10000ms exceeded.';
    const passenger = {
      at: 0,
      title: 'Passenger Information',
      result: {
        filled: ['passportImage', 'readTheNotes'],
        missing: [],
        failed: [],
      },
      onThePage: {
        fullName: 'TRAVELLER JORDAN',
        gender: 'Male',
        dateOfBirth: '04/11/1988',
        nationality: 'Wonderland',
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
      shot: Buffer.from('passenger'),
    };
    const page = {
      at: 1,
      title: 'Trip Information',
      result: {
        filled: ['modeOfTravel', 'accommodationType'],
        missing: [],
        failed: [failed],
      },
      onThePage: {
        modeOfTravel: 'Air',
        vehicleNumber: 'XX1234',
        borderGate: 'XYZ - Example International Airport',
        purpose: 'Travel',
        // The live site selects Hotel by default, and that visible selection
        // is a filled value even when it did not come from a document.
        accommodationType: 'Hotel',
        province: 'Example City',
        ward: 'Central Ward',
        accommodationAddress: '100 Example Street',
      },
      shot: Buffer.from('blocked'),
    };
    const answer = arrivalAnswerFor({
      walk: {
        reached: 1,
        stopped: 'Trip Information',
        refused: [],
        pages: [page.result],
      },
      captured: [passenger, page],
      applicant: {},
      session,
      strings: MESSAGES.ru,
      describeFilled,
    });

    expect(answer.caption.includes('где остановитесь')).toBe(false);
    expect(answer.caption.includes('дата вылета из Вьетнама')).toBe(false);
    expect(answer.caption.includes('Информация о поездке')).toBe(true);
    expect(answer.caption.includes('Trip Information')).toBe(false);
    expect(answer.caption.includes('Сайт не принял')).toBe(false);
    expect(answer.caption.includes('Ещё нужно заполнить')).toBe(true);
    expect(answer.caption.includes('Браузер остаётся открытым')).toBe(true);
    expect(answer.caption.includes('откуда летите')).toBe(true);
    expect(answer.caption.includes('locator.waitFor')).toBe(false);
    expect(answer.caption.includes('Please fill')).toBe(false);
    for (const filledValue of [
      'TRAVELLER JORDAN',
      '712345678',
      'Electronic Visa (E-Visa) · 712345678',
      'Example Immigration Department',
      'traveller@example.com',
      'XX1234',
      'Example International Airport',
      '100 Example Street',
    ]) {
      expect(answer.caption.includes(filledValue)).toBe(true);
    }
    expect(answer.caption.includes('Страница 1 заполнена')).toBe(true);
    expect(answer.caption.includes('На странице 2 заполнено')).toBe(true);
    expect(answer.caption.includes('паспорт загружен')).toBe(true);
    expect(answer.caption.includes('проживание: Hotel')).toBe(true);
    expect(answer.caption.length <= 1024).toBe(true);
    expect(answer.shots.map((shot) => shot.toString())).toEqual([
      'passenger',
      'blocked',
    ]);

    const sent = [];
    await sendArrivalAnswer({
      ctx: {
        reply: async (...args) => sent.push(['text', ...args]),
        replyWithPhoto: async (...args) => sent.push(['photo', ...args]),
      },
      chatId: 1,
      answer,
      session,
      strings: MESSAGES.ru,
      InputFile,
      log: () => {},
      combineScreenshots: async (shots) =>
        Buffer.from(shots.map((shot) => shot.toString()).join('+')),
    });
    expect(sent.length).toBe(1);
    expect(sent[0][0]).toBe('photo');
    expect(sent[0][1].bytes.toString()).toBe('passenger+blocked');
  });
});

describe('the one image containing the declaration pages', () => {
  it('stacks the pages in visit order without changing their width', async () => {
    const { default: sharp } = await import('sharp');
    const passenger = await solidPng(sharp, 8, 5, '#d32f2f');
    const trip = await solidPng(sharp, 6, 7, '#1976d2');
    const combined = await combineArrivalScreenshots([passenger, trip], {
      gap: 3,
    });
    const { data, info } = await sharp(combined)
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(info.width).toBe(8);
    expect(info.height).toBe(15);
    expect(pixelAt(data, info, 0, 0)).toEqual([211, 47, 47]);
    expect(pixelAt(data, info, 1, 6)).toEqual([255, 255, 255]);
    expect(pixelAt(data, info, 1, 14)).toEqual([25, 118, 210]);
  });

  it('returns one page unchanged and no image for no pages', async () => {
    const one = Buffer.from('one page');
    expect(await combineArrivalScreenshots([one])).toBe(one);
    expect(await combineArrivalScreenshots([])).toBe(null);
  });

  it('keeps a multi-page photo within Telegram dimensions', async () => {
    const { default: sharp } = await import('sharp');
    const page = await solidPng(sharp, 80, 50, '#ffffff');
    const combined = await combineArrivalScreenshots([page, page, page], {
      gap: 5,
      maxDimensionSum: 100,
    });
    const { width, height } = await sharp(combined).metadata();
    expect(width + height <= 100).toBe(true);
  });
});

describe('safe consolidated arrival replies', () => {
  it('never calls a page complete when the site kept it blocked', () => {
    const session = { language: 'en' };
    const page = {
      at: 1,
      title: 'Trip Information',
      result: { filled: [], missing: [], failed: [] },
      onThePage: {},
      shot: Buffer.from('blocked'),
    };
    const answer = arrivalAnswerFor({
      walk: {
        reached: 1,
        stopped: 'Trip Information',
        refused: ['Please fill in the field above'],
        pages: [page.result],
      },
      captured: [page],
      session,
      strings: MESSAGES.en,
      describeFilled,
    });

    expect(answer.caption).toContain('The site would not accept');
    expect(answer.caption.includes(MESSAGES.en.arrivalYours)).toBe(false);
  });

  it('keeps a warning that arrives while the answer is sending', async () => {
    const session = { language: 'en' };
    noteDocumentIssue(session, 'downloadFailed');
    let deliver;
    const delivered = new Promise((resolve) => {
      deliver = resolve;
    });
    const sending = sendArrivalAnswer({
      ctx: { reply: () => delivered },
      chatId: 1,
      answer: {
        caption: `answer\n\n${MESSAGES.en.documentIssues.downloadFailed(1)}`,
        shot: null,
      },
      session,
      strings: MESSAGES.en,
      InputFile,
      log: () => {},
    });
    noteDocumentIssue(session, 'unknownImage');
    deliver();

    expect(await sending).toBe(true);
    expect(describeIssues(session)).toContain('not identified or used');
    expect(describeIssues(session).includes('did not download')).toBe(false);
  });

  it('restores warnings when the consolidated answer does not send', async () => {
    const session = { language: 'en' };
    noteDocumentIssue(session, 'downloadFailed');
    const sent = await sendArrivalAnswer({
      ctx: { reply: async () => Promise.reject(new Error('offline')) },
      chatId: 1,
      answer: { caption: 'answer', shot: null },
      session,
      strings: MESSAGES.en,
      InputFile,
      log: () => {},
    });

    expect(sent).toBe(false);
    expect(describeIssues(session)).toContain('did not download');
  });

  it('keeps the screenshot even when an unexpected caption is too long', async () => {
    const sent = [];
    const session = { language: 'en' };
    await sendArrivalAnswer({
      ctx: {
        reply: async (...args) => sent.push(['text', ...args]),
        replyWithPhoto: async (...args) => sent.push(['photo', ...args]),
      },
      chatId: 1,
      answer: {
        caption: `<b>${'word '.repeat(300)}</b>`,
        shot: Buffer.from('review'),
      },
      session,
      strings: MESSAGES.en,
      InputFile,
      log: () => {},
    });

    expect(sent.length).toBe(1);
    expect(sent[0][0]).toBe('photo');
    expect(sent[0][2].caption.length <= 1024).toBe(true);
  });

  it('leaves a blocked correction in form stage, never review stage', async () => {
    const held = { stage: 'review' };
    await settleArrivalWalk({
      walk: { reached: 1, stopped: 'Trip Information', refused: [] },
      first: { filled: [], missing: [], failed: [] },
      page: {},
      applicant: {},
      held,
      session: { arrival: held },
      chatId: 1,
      log: () => {},
    });
    expect(held.stage).toBe('form');
  });
});

describe('Telegram caption limits', () => {
  it('fits the complete Russian warning set under its screenshot', () => {
    const session = { language: 'ru' };
    const issues = [
      'downloadFailed',
      'compressedPhoto',
      'passportPageUncertain',
      'bookingWithoutAddress',
      'unknownImage',
    ];
    for (const issue of issues) {
      noteDocumentIssue(session, issue);
    }
    const passenger = {
      at: 0,
      result: {
        filled: ['passportImage', 'readTheNotes'],
        missing: [],
        failed: ['passportImage: failed'],
      },
      onThePage: {
        fullName: 'TRAVELLER ALEXANDER MAXIMILIAN CONSTANTIN',
        gender: 'Male',
        dateOfBirth: '16/09/1979',
        nationality: 'Example Federation',
        passportType: 'P - Popular Passport',
        passportNumber: '712345678',
        passportExpiryDate: '[REDACTED]',
        visaType: 'Electronic Visa (E-Visa)',
        visaNumber: '712345678',
        visaIssueDate: '[REDACTED]',
        visaExpiryDate: '[REDACTED]',
        visaIssuedPlace:
          'Example Immigration Department - Ministry of Public Security',
        arrivalDate: '[REDACTED]',
        email: 'traveller@example.com',
        phone: '+79999999999',
      },
      shot: Buffer.from('passenger'),
    };
    const review = {
      at: 2,
      result: { filled: [], missing: [], failed: [] },
      onThePage: {},
      shot: Buffer.from('review'),
    };
    const answer = arrivalAnswerFor({
      walk: { reached: 2, pages: [passenger.result, review.result] },
      captured: [passenger, review],
      session,
      strings: MESSAGES.ru,
      describeFilled,
    });

    expect(answer.caption.length <= 1024).toBe(true);
    expect(answer.caption).toContain(MESSAGES.ru.arrivalPassportUnread);
    for (const issue of issues) {
      expect(answer.caption).toContain(MESSAGES.ru.documentIssues[issue](1));
    }
  });
});

function describeIssues(session) {
  return `${MESSAGES.en.documentIssuesHeading}\n${Object.entries(
    session.documentIssues ?? {}
  )
    .map(([issue, count]) => MESSAGES.en.documentIssues[issue](count))
    .join('\n')}`;
}

/** A tiny lossless page fixture in one solid colour. */
function solidPng(sharp, width, height, background) {
  return sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();
}

/** The RGB triplet at one point in a decoded test image. */
function pixelAt(data, info, x, y) {
  const at = (y * info.width + x) * info.channels;
  return [...data.subarray(at, at + 3)];
}
