import { describe, it, expect } from 'test-anywhere';
import { showStatus } from '../src/evisa-status.mjs';

/** A chat that records every status sent, and can be made slow to answer. */
function chat({ delay = 0 } = {}) {
  const sent = [];
  return {
    sent,
    ctx: {
      chat: { id: 1 },
      replyWithChatAction: async (action) => {
        sent.push(action);
        if (delay) {
          await new Promise((done) => setTimeout(done, delay));
        }
      },
    },
  };
}

/** The same cycle, run in tens of milliseconds so a test finishes. */
const FAST = { everyMs: 30, waitMs: 25 };

const after = (ms) => new Promise((done) => setTimeout(done, ms));

describe('the status the chat shows while the bot works', () => {
  it('renews itself for as long as the work runs', async () => {
    const { ctx, sent } = chat();
    const stop = showStatus(ctx, 'typing', () => {}, FAST);
    await after(150);
    stop();
    // Renewed every three seconds: one at the start and two more.
    expect(sent.length >= 3).toBe(true);
    expect(sent.every((action) => action === 'typing')).toBe(true);
  });

  it('goes on renewing when one send is slow to come back', async () => {
    // The bot's client waits ninety seconds for a call. Awaiting a slow one
    // stopped the renewals for that whole time, and Telegram clears the
    // status after five seconds — so the chat went quiet with nothing
    // failing and nothing logged.
    const { ctx, sent } = chat({ delay: 5000 });
    const stop = showStatus(ctx, 'typing', () => {}, FAST);
    await after(200);
    stop();
    // Without a bound of its own this would be stuck at one.
    expect(sent.length >= 2).toBe(true);
  });

  it('stops when it is told to, and sends nothing after', async () => {
    const { ctx, sent } = chat();
    const stop = showStatus(ctx, 'typing', () => {}, FAST);
    await after(500);
    stop();
    const atStop = sent.length;
    await after(150);
    expect(sent.length).toBe(atStop);
  });

  it('says so in the log when the chat saw gaps', async () => {
    const lines = [];
    const { ctx } = chat({ delay: 5000 });
    const stop = showStatus(
      ctx,
      'typing',
      (id, line) => lines.push(line),
      FAST
    );
    await after(200);
    stop();
    // A status held nine seconds should have been renewed three times.
    expect(lines.some((line) => line.includes('the chat saw gaps'))).toBe(true);
  });

  it('says nothing in the log about a status that kept up', async () => {
    const lines = [];
    const { ctx } = chat();
    const stop = showStatus(
      ctx,
      'typing',
      (id, line) => lines.push(line),
      FAST
    );
    await after(150);
    stop();
    expect(lines.some((line) => line.includes('saw gaps'))).toBe(false);
  });
});
