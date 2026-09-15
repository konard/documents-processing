import { describe, it, expect } from 'test-anywhere';
import {
  declarationAdvancer,
  confirmDeclarationReview,
  declarationEmailCodeTaker,
  declarationFiler,
  tripCheckpointFromValues,
} from '../src/evisa-arrival-run.mjs';
import { describeFilled } from '../src/evisa-bot.mjs';
import { MESSAGES } from '../src/evisa-messages.mjs';

function tripValues(overrides = {}) {
  return {
    departedFrom: 'India',
    purpose: 'Travel',
    modeOfTravel: 'Air',
    vehicleNumber: '[REDACTED]',
    borderGate: 'SGN - Tan Son Nhat International Airport',
    accommodationType: 'Hotel',
    province: 'Ho Chi Minh City',
    ward: 'Tan Binh Ward',
    accommodationAddress: '[REDACTED]',
    ...overrides,
  };
}

function staged(stage, at) {
  const sent = [];
  const turns = [];
  const session = {
    language: 'ru',
    data: {},
    arrival: { stage, page: { name: 'same live browser page' } },
  };
  const advance = declarationAdvancer({
    sessions: { get: () => session },
    log: () => {},
    MESSAGES,
    describeFilled,
    stepOf: async () => ({ at, titles: [] }),
    turnPage: async (_page, name) => {
      turns.push(name);
      return { turned: true, at: at + 1, refused: [] };
    },
    readPassengerPage: async () => ({
      values: { fullName: 'TRAVELLER JORDAN' },
      result: { filled: ['fullName'], missing: [], failed: [] },
    }),
    readTripPage: async () => tripCheckpointFromValues(tripValues()),
    fillTripPage: async () => ({
      filled: Object.keys(tripValues()),
      missing: [],
      failed: [],
    }),
    capturePage: async ({ at: pageAt, title, result }) => ({
      at: pageAt,
      title,
      result,
      onThePage: pageAt === 1 ? tripValues() : {},
      shot: Buffer.from(`page-${pageAt + 1}`),
    }),
    secureReview: async () => true,
    sendPage: async ({ answer }) => {
      sent.push(answer);
      return true;
    },
  });
  return { advance, sent, session, turns };
}

describe('page-by-page declaration checkpoints', () => {
  it('one passenger confirmation fills and shows page 2, then stops', async () => {
    const { advance, sent, session, turns } = staged('passenger', 0);

    expect(await advance({}, 1)).toBe(true);
    expect(turns).toEqual(['Trip Information']);
    expect(session.arrival.stage).toBe('trip');
    expect(session.arrival.page.name).toBe('same live browser page');
    expect(sent.length).toBe(1);
    expect(sent[0].shot.toString()).toBe('page-2');
    expect(sent[0].caption).toContain('Страница 2 из 3');
    expect(sent[0].caption).not.toContain('Страница 3 из 3');
    expect(sent[0].caption.endsWith(MESSAGES.ru.arrivalPageReady)).toBe(true);
  });

  it('one trip confirmation shows Review without filing', async () => {
    const { advance, sent, session, turns } = staged('trip', 1);

    expect(await advance({}, 1)).toBe(true);
    expect(turns).toEqual(['Review & Submit']);
    expect(session.arrival.stage).toBe('review');
    expect(sent.length).toBe(1);
    expect(sent[0].shot.toString()).toBe('page-3');
    expect(sent[0].caption).not.toContain('Submit не нажат');
    expect(sent[0].caption.endsWith(MESSAGES.ru.arrivalReviewReady)).toBe(true);
  });

  it('sends only a CAPTCHA image when a gate interrupts Next', async () => {
    const captchas = [];
    let captures = 0;
    const session = {
      language: 'ru',
      data: {},
      arrival: { stage: 'trip', page: {} },
    };
    const advance = declarationAdvancer({
      sessions: { get: () => session },
      log: () => {},
      MESSAGES,
      describeFilled,
      stepOf: async () => ({ at: 1, titles: [] }),
      readTripPage: async () => tripCheckpointFromValues(tripValues()),
      turnPage: async () => ({
        turned: false,
        at: 1,
        refused: [],
        captcha: true,
      }),
      capturePage: async () => {
        captures += 1;
      },
      askCaptcha: async (_ctx, _chatId, caption) => {
        captchas.push(caption);
        return true;
      },
    });

    expect(await advance({}, 1)).toBe(false);
    expect(captures).toBe(0);
    expect(captchas).toEqual([MESSAGES.ru.arrivalCaptchaContinue]);
    expect(session.arrival.stage).toBe('captcha');
    expect(session.arrival.resumeStage).toBe('trip');
  });
});

describe('review-page confirmation', () => {
  it('checks the mandatory box before the screenshot without pressing Submit', async () => {
    let checked = false;
    let submitted = false;
    const box = {
      isVisible: async () => true,
      isChecked: async () => checked,
      check: async () => {
        checked = true;
      },
    };
    const page = {
      getByRole: () => ({ first: () => box }),
      getByText: () => ({
        first: () => ({
          click: async () => {
            submitted = true;
          },
        }),
      }),
    };

    expect(await confirmDeclarationReview(page)).toBe(true);
    expect(checked).toBe(true);
    expect(submitted).toBe(false);
  });
});

describe('checkpoint delivery safeguards', () => {
  it('resends an unseen passenger page before allowing it to advance', async () => {
    const { advance, sent, session, turns } = staged('passenger', 0);
    session.arrival.pageDelivered = false;

    expect(await advance({}, 1)).toBe(false);
    expect(turns).toEqual([]);
    expect(session.arrival.stage).toBe('passenger');
    expect(session.arrival.pageDelivered).toBe(true);
    expect(sent[0].shot.toString()).toBe('page-1');
    expect(sent[0].caption.endsWith(MESSAGES.ru.arrivalPageReady)).toBe(true);
  });

  it('cannot skip an unseen trip page after its Telegram delivery fails', async () => {
    const { session, turns } = staged('passenger', 0);
    const failed = declarationAdvancer({
      sessions: { get: () => session },
      log: () => {},
      MESSAGES,
      describeFilled,
      stepOf: async () => ({ at: 0, titles: [] }),
      turnPage: async (_page, name) => {
        turns.push(name);
        return { turned: true, at: 1, refused: [] };
      },
      readPassengerPage: async () => ({
        values: { fullName: 'TRAVELLER JORDAN' },
        result: { filled: ['fullName'], missing: [], failed: [] },
      }),
      fillTripPage: async () => ({
        filled: Object.keys(tripValues()),
        missing: [],
        failed: [],
      }),
      capturePage: async ({ at, title, result }) => ({
        at,
        title,
        result,
        onThePage: tripValues(),
        shot: Buffer.from('page-2'),
      }),
      sendPage: async () => false,
    });

    expect(await failed({}, 1)).toBe(false);
    expect(turns).toEqual(['Trip Information']);
    expect(session.arrival.stage).toBe('passenger');
  });

  it('cannot file an unseen Review page after its Telegram delivery fails', async () => {
    const { session, turns } = staged('trip', 1);
    const failed = declarationAdvancer({
      sessions: { get: () => session },
      log: () => {},
      MESSAGES,
      describeFilled,
      stepOf: async () => ({ at: 1, titles: [] }),
      turnPage: async (_page, name) => {
        turns.push(name);
        return { turned: true, at: 2, refused: [] };
      },
      readTripPage: async () => tripCheckpointFromValues(tripValues()),
      secureReview: async () => true,
      capturePage: async ({ at, title, result }) => ({
        at,
        title,
        result,
        onThePage: {},
        shot: Buffer.from('page-3'),
      }),
      sendPage: async () => false,
    });

    expect(await failed({}, 1)).toBe(false);
    expect(turns).toEqual(['Review & Submit']);
    expect(session.arrival.stage).toBe('trip');
  });

  it('does not screenshot Review until its mandatory box is checked', async () => {
    const { session, turns } = staged('trip', 1);
    const replies = [];
    let captures = 0;
    const failed = declarationAdvancer({
      sessions: { get: () => session },
      log: () => {},
      MESSAGES,
      describeFilled,
      stepOf: async () => ({ at: 1, titles: [] }),
      turnPage: async (_page, name) => {
        turns.push(name);
        return { turned: true, at: 2, refused: [] };
      },
      readTripPage: async () => tripCheckpointFromValues(tripValues()),
      secureReview: async () => false,
      capturePage: async () => {
        captures += 1;
      },
    });

    expect(await failed({ reply: async (text) => replies.push(text) }, 1)).toBe(
      false
    );
    expect(turns).toEqual(['Review & Submit']);
    expect(captures).toBe(0);
    expect(session.arrival.stage).toBe('trip');
    expect(replies).toEqual([MESSAGES.ru.arrivalReviewSafetyUnknown]);
  });

  it('logs browser details without exposing them to the traveller', async () => {
    const logged = [];
    const replies = [];
    const { session } = staged('passenger', 0);
    const failed = declarationAdvancer({
      sessions: { get: () => session },
      log: (_chatId, line) => logged.push(line),
      MESSAGES,
      describeFilled,
      stepOf: async () => {
        throw new Error('locator.waitFor: Timeout 10000ms exceeded');
      },
    });

    expect(await failed({ reply: async (text) => replies.push(text) }, 1)).toBe(
      false
    );
    expect(logged.join('\n')).toContain('locator.waitFor');
    expect(replies).toEqual([MESSAGES.ru.arrivalNotAdvanced]);
    expect(replies.join('\n')).not.toContain('locator');
  });
});

describe('required declaration fields', () => {
  it('accepts the complete default stay without an optional departure date', () => {
    const checkpoint = tripCheckpointFromValues(tripValues());
    expect(checkpoint.result.missing).toEqual([]);
    expect(checkpoint.result.filled).toContain('accommodationAddress');
    expect(checkpoint.result.filled).not.toContain('departureDate');
  });

  it('asks for the flight again when it produced no border gate', () => {
    const checkpoint = tripCheckpointFromValues(tripValues({ borderGate: '' }));
    expect(checkpoint.result.missing).toEqual(['vehicleNumber']);
  });

  it('does not advance when a genuinely required stay field is empty', async () => {
    const { sent, session, turns } = staged('trip', 1);
    const original = tripCheckpointFromValues(tripValues());
    original.values.accommodationAddress = undefined;
    original.result = tripCheckpointFromValues(
      tripValues({ accommodationAddress: '' })
    ).result;
    const blocked = declarationAdvancer({
      sessions: { get: () => session },
      log: () => {},
      MESSAGES,
      describeFilled,
      stepOf: async () => ({ at: 1, titles: [] }),
      turnPage: async () => {
        turns.push('unexpected');
        return { turned: true, at: 2, refused: [] };
      },
      readTripPage: async () => original,
      capturePage: async ({ at, title, result }) => ({
        at,
        title,
        result,
        onThePage: original.values,
        shot: Buffer.from('page-2'),
      }),
      sendPage: async ({ answer }) => {
        sent.push(answer);
        return true;
      },
    });

    expect(await blocked({}, 1)).toBe(false);
    expect(turns).toEqual([]);
    expect(session.arrival.stage).toBe('trip');
    expect(sent[0].caption).toContain('адрес во Вьетнаме');
    expect(sent[0].caption).not.toContain('дата вылета из Вьетнама');
  });
});

// Each case protects a separate irreversible-action checkpoint.
// eslint-disable-next-line max-lines-per-function
describe('final declaration confirmation', () => {
  it('admits only one filing call when confirmations arrive together', async () => {
    let release;
    let filings = 0;
    const result = new Promise((resolve) => {
      release = resolve;
    });
    const replies = [];
    const session = {
      language: 'ru',
      arrival: { stage: 'review', page: {} },
    };
    const file = declarationFiler({
      sessions: { get: () => session },
      log: () => {},
      MESSAGES,
      captchaOnPage: () => false,
      fileDeclaration: async () => {
        filings += 1;
        return result;
      },
    });
    const ctx = { reply: async (text) => replies.push(text) };

    const first = file(ctx, 1);
    expect(session.arrival.stage).toBe('filing');
    expect(await file(ctx, 1)).toBe(false);
    expect(filings).toBe(1);
    release({ filed: true });
    expect(await first).toBe(true);
    expect(session.arrival.stage).toBe('filed');
  });

  it('never exposes or automatically retries an unknown filing outcome', async () => {
    const replies = [];
    const logs = [];
    const session = {
      language: 'ru',
      arrival: { stage: 'review', page: {} },
    };
    const file = declarationFiler({
      sessions: { get: () => session },
      log: (_chatId, line) => logs.push(line),
      MESSAGES,
      fileDeclaration: async () => {
        throw new Error('locator.click: browser closed after Submit');
      },
    });

    expect(await file({ reply: async (text) => replies.push(text) }, 1)).toBe(
      false
    );
    expect(session.arrival.stage).toBe('filing-unknown');
    expect(logs.join('\n')).toContain('locator.click');
    expect(replies.at(-1)).toBe(MESSAGES.ru.arrivalFilingUnknown);
    expect(replies.join('\n')).not.toContain('locator');
  });

  it('pauses final filing at a CAPTCHA without reporting missing fields', async () => {
    const replies = [];
    const captchas = [];
    const session = {
      language: 'ru',
      arrival: { stage: 'review', page: {} },
    };
    const file = declarationFiler({
      sessions: { get: () => session },
      log: () => {},
      MESSAGES,
      captchaOnPage: async () => false,
      fileDeclaration: async () => ({ captcha: true, filed: false }),
      askCaptcha: async (_ctx, _chatId, caption) => {
        captchas.push(caption);
        return true;
      },
    });

    expect(await file({ reply: async (text) => replies.push(text) }, 1)).toBe(
      false
    );
    expect(session.arrival.stage).toBe('captcha');
    expect(session.arrival.resumeStage).toBe('review');
    expect(captchas).toEqual([MESSAGES.ru.arrivalCaptchaContinue]);
    expect(replies).toEqual([]);
    expect(replies.join('\n')).not.toContain('недоста');
  });

  it('asks for the email code when Submit opens email verification', async () => {
    const replies = [];
    const session = {
      language: 'ru',
      arrival: { stage: 'review', page: {} },
    };
    const file = declarationFiler({
      sessions: { get: () => session },
      log: () => {},
      MESSAGES,
      captchaOnPage: async () => false,
      fileDeclaration: async () => ({ emailCode: true, filed: false }),
    });

    expect(await file({ reply: async (text) => replies.push(text) }, 1)).toBe(
      false
    );
    expect(session.arrival.stage).toBe('email-code');
    expect(replies).toEqual([MESSAGES.ru.arrivalEmailCode]);
    expect(replies.join('\n')).not.toContain('site stayed');
  });

  it('takes a six-digit email code and reports the filed result', async () => {
    const replies = [];
    const verified = [];
    const session = {
      language: 'ru',
      arrival: { stage: 'email-code', page: {} },
    };
    const takeCode = declarationEmailCodeTaker({
      sessions: { get: () => session },
      log: () => {},
      MESSAGES,
      verifyEmail: async (_page, code) => {
        verified.push(code);
        return { filed: true };
      },
    });

    expect(
      await takeCode(
        {
          message: { text: '123456' },
          reply: async (text) => replies.push(text),
        },
        1
      )
    ).toBe(true);
    expect(verified).toEqual(['123456']);
    expect(session.arrival.stage).toBe('filed');
    expect(replies).toEqual([MESSAGES.ru.arrivalFiled]);
  });

  it('reports a duplicate result without claiming filing success', async () => {
    const replies = [];
    const session = {
      language: 'ru',
      arrival: { stage: 'email-code', page: {} },
    };
    const takeCode = declarationEmailCodeTaker({
      sessions: { get: () => session },
      log: () => {},
      MESSAGES,
      verifyEmail: async () => ({
        filed: false,
        duplicate: true,
        passportNumber: '[REDACTED]',
      }),
    });

    expect(
      await takeCode(
        {
          message: { text: '123456' },
          reply: async (text) => replies.push(text),
        },
        1
      )
    ).toBe(true);
    expect(session.arrival.stage).toBe('duplicate');
    expect(replies).toEqual([MESSAGES.ru.arrivalDuplicate('[REDACTED]')]);
    expect(replies.join('\n')).not.toContain('успешно подана');
  });

  it('asks again after the site refuses an email code', async () => {
    const replies = [];
    const session = {
      language: 'ru',
      arrival: { stage: 'email-code', page: {} },
    };
    const takeCode = declarationEmailCodeTaker({
      sessions: { get: () => session },
      log: () => {},
      MESSAGES,
      verifyEmail: async () => ({
        filed: false,
        emailCode: true,
        why: 'verification code was refused',
      }),
    });

    expect(
      await takeCode(
        {
          message: { text: '654321' },
          reply: async (text) => replies.push(text),
        },
        1
      )
    ).toBe(true);
    expect(session.arrival.stage).toBe('email-code');
    expect(replies).toEqual([MESSAGES.ru.arrivalEmailCodeAgain]);
  });

  it('does not claim unrelated text as an email code', async () => {
    const session = {
      language: 'ru',
      arrival: { stage: 'email-code', page: {} },
    };
    const takeCode = declarationEmailCodeTaker({
      sessions: { get: () => session },
      log: () => {},
      MESSAGES,
    });

    expect(await takeCode({ message: { text: '12345' } }, 1)).toBe(false);
    expect(await takeCode({ message: { text: 'ABC123' } }, 1)).toBe(false);
    expect(session.arrival.stage).toBe('email-code');
  });
});
