import { describe, it, expect } from 'test-anywhere';
import { onShutdown } from '../src/evisa-shutdown.mjs';

/** A run with two chats open, recording what happens and in what order. */
function aRun({ sayTakes = 0, closeTakes = 0 } = {}) {
  const done = [];
  const signals = new Map();
  const shutDown = onShutdown({
    browsers: new Map([
      [1, {}],
      [2, {}],
    ]),
    sessions: { get: () => ({ language: 'ru' }) },
    MESSAGES: {
      ru: { restarting: 'выключаюсь' },
      en: { restarting: 'closing' },
    },
    log: () => {},
    clearStatus: (chatId) => done.push(`status out ${chatId}`),
    endChat: async (chatId) => {
      if (closeTakes) {
        await new Promise((ready) => setTimeout(ready, closeTakes));
      }
      done.push(`browser closed ${chatId}`);
    },
    say: async (chatId, text) => {
      if (sayTakes) {
        await new Promise((ready) => setTimeout(ready, sayTakes));
      }
      done.push(`told ${chatId}: ${text}`);
    },
    stopBot: async () => done.push('bot stopped'),
    told: 200,
    closed: 200,
    exit: () => done.push('exited'),
    signals: { on: (name, run) => signals.set(name, run) },
  });
  return { done, shutDown, signals };
}

describe('closing the bot down', () => {
  it('tells every chat before it closes a single window', async () => {
    const { done, shutDown } = aRun();
    await shutDown('a test');
    const lastTold = done.findLastIndex((step) => step.startsWith('told'));
    const firstClosed = done.findIndex((step) =>
      step.startsWith('browser closed')
    );
    // Said while the window is still there, so the applicant reads why it goes.
    expect(lastTold < firstClosed).toBe(true);
  });

  it('puts the typing out: a bot on its way out is working on nothing', async () => {
    const { done, shutDown } = aRun();
    await shutDown('a test');
    expect(done.filter((step) => step.startsWith('status out')).length).toBe(2);
  });

  it('says what it says in the applicant´s language', async () => {
    const { done, shutDown } = aRun();
    await shutDown('a test');
    expect(done.some((step) => step.includes('выключаюсь'))).toBe(true);
  });

  it('stops the bot and exits, in that order, at the end', async () => {
    const { done, shutDown } = aRun();
    await shutDown('a test');
    expect(done.slice(-2)).toEqual(['bot stopped', 'exited']);
  });

  it('goes on when a chat will not answer', async () => {
    // A chat that never takes the message must not hold the process open.
    const { done, shutDown } = aRun({ sayTakes: 10_000 });
    await shutDown('a test');
    expect(done.includes('exited')).toBe(true);
  });

  it('goes on when a browser will not close', async () => {
    const { done, shutDown } = aRun({ closeTakes: 10_000 });
    await shutDown('a test');
    expect(done.includes('exited')).toBe(true);
  });

  it('closes down once, however many signals arrive', async () => {
    const { done, shutDown } = aRun();
    await Promise.all([shutDown('one'), shutDown('two'), shutDown('three')]);
    expect(done.filter((step) => step === 'exited').length).toBe(1);
  });

  it('answers a Ctrl+C and a stop signal alike', () => {
    const { signals } = aRun();
    expect([...signals.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
  });
});
