import { describe, it, expect } from 'test-anywhere';
import {
  arrivalAnswerFor,
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
  it('sends only the review screenshot with a complete passenger check', async () => {
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
      'could not use the passport image as a second reading',
      'transfer failure, not a photo-quality problem',
    ]) {
      expect(answer.caption.includes(wanted)).toBe(true);
    }
    expect(answer.caption.length <= 1024).toBe(true);
    expect(answer.shot.toString()).toBe('review');

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
      })
    ).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0][0]).toBe('photo');
    expect(sent[0][1].bytes.toString()).toBe('review');
    expect(session.documentIssues).toBe(undefined);
  });

  it('shows one blocked-page screenshot with localised actionable fields', async () => {
    const session = { language: 'ru' };
    const failed = 'departedFrom: locator.waitFor: Timeout 10000ms exceeded.';
    const page = {
      at: 1,
      title: 'Trip Information',
      result: {
        filled: ['modeOfTravel'],
        missing: ['accommodationType', 'departureDate'],
        failed: [failed],
      },
      onThePage: { modeOfTravel: 'Air' },
      shot: Buffer.from('blocked'),
    };
    const answer = arrivalAnswerFor({
      walk: {
        reached: 1,
        stopped: 'Trip Information',
        refused: [],
        pages: [page.result],
      },
      captured: [page],
      applicant: {},
      session,
      strings: MESSAGES.ru,
      describeFilled,
    });

    expect(answer.caption.includes('где остановитесь')).toBe(true);
    expect(answer.caption.includes('дата вылета из Вьетнама')).toBe(true);
    expect(answer.caption.includes('Информация о поездке')).toBe(true);
    expect(answer.caption.includes('Trip Information')).toBe(false);
    expect(answer.caption.includes('Сайт не принял')).toBe(false);
    expect(answer.caption.includes('ещё не хватает')).toBe(true);
    expect(answer.caption.includes('откуда летите')).toBe(true);
    expect(answer.caption.includes('locator.waitFor')).toBe(false);
    expect(answer.caption.includes('Please fill')).toBe(false);

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
    });
    expect(sent.length).toBe(1);
    expect(sent[0][0]).toBe('photo');
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

    expect(answer.caption.includes(MESSAGES.en.arrivalNeedsWork)).toBe(true);
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
    expect(describeIssues(session)).toContain('could not identify 1 image');
    expect(describeIssues(session).includes('transfer failure')).toBe(false);
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
    expect(describeIssues(session)).toContain('transfer failure');
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
      result: { filled: [], missing: [], failed: ['passportImage: failed'] },
      onThePage: {
        fullName: 'TRAVELLER ALEXANDER MAXIMILIAN CONSTANTIN',
        gender: 'Male',
        arrivalDate: '[REDACTED]',
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
