import { describe, it, expect } from 'test-anywhere';
import { createBatcher } from '../src/evisa-batch.mjs';

/** A batcher that counts its fills and notices two running at once. */
function counting({ quietMs = 40, fillMs = 60 } = {}) {
  const state = { fills: 0, inFill: 0, overlaps: 0 };
  const batch = createBatcher({
    quietMs,
    fill: async () => {
      state.inFill += 1;
      if (state.inFill > 1) {
        state.overlaps += 1;
      }
      state.fills += 1;
      await new Promise((resolve) => setTimeout(resolve, fillMs));
      state.inFill -= 1;
    },
  });
  return { batch, state };
}

const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('one fill for everything an applicant sends', () => {
  it('fills once for a batch forwarded in the same instant', async () => {
    // Forwarding several documents lands them all in the same second.
    const { batch, state } = counting();
    for (let at = 0; at < 10; at++) {
      batch.arrived('c', {});
    }
    await after(300);
    expect(state.fills).toBe(1);
  });

  it('waits for every reading before it fills', async () => {
    // A passport takes the better part of a minute to read, and a form put
    // up before that finished would not have the passport on it.
    const { batch, state } = counting();
    const read = [];
    for (let at = 0; at < 3; at++) {
      batch.arrived('c', {});
      read.push(batch.reading('c', () => after(120)));
    }
    // The window alone would have passed by now.
    await after(80);
    expect(state.fills).toBe(0);
    await Promise.all(read);
    await after(200);
    expect(state.fills).toBe(1);
  });

  it('keeps the window open while messages keep arriving', async () => {
    const { batch, state } = counting();
    batch.arrived('c', {});
    for (const at of [20, 40, 60, 80]) {
      setTimeout(() => batch.arrived('c', {}), at);
    }
    await after(400);
    expect(state.fills).toBe(1);
  });

  it('never runs two fills at once', async () => {
    // A message landing during a fill is filled after it, on the same page.
    const { batch, state } = counting({ fillMs: 120 });
    batch.arrived('c', {});
    setTimeout(() => batch.arrived('c', {}), 70);
    await after(500);
    expect(state.overlaps).toBe(0);
    expect(state.fills).toBe(2);
  });

  it('fills again for what arrived while it was filling', async () => {
    const { batch, state } = counting({ fillMs: 100 });
    batch.arrived('c', {});
    setTimeout(() => batch.arrived('c', {}), 60);
    await after(400);
    // The second message is not lost to the fill that was already running.
    expect(state.fills).toBe(2);
  });

  it('goes on filling after a reading fails', async () => {
    const { batch, state } = counting();
    batch.arrived('c', {});
    batch
      .reading('c', () => Promise.reject(new Error('could not read')))
      .catch(() => {});
    await after(300);
    expect(state.fills).toBe(1);
  });

  it('goes on filling after a fill fails', async () => {
    let tries = 0;
    const batch = createBatcher({
      quietMs: 40,
      fill: async () => {
        tries += 1;
        if (tries === 1) {
          throw new Error('the page was closed');
        }
      },
    });
    batch.arrived('c', {});
    await after(200);
    batch.arrived('c', {});
    await after(200);
    expect(tries).toBe(2);
  });

  it('keeps one chat apart from another', async () => {
    const { batch, state } = counting();
    batch.arrived('one', {});
    batch.arrived('two', {});
    await after(300);
    expect(state.fills).toBe(2);
  });

  it('fills nothing for a chat that was stopped', async () => {
    const { batch, state } = counting();
    batch.arrived('c', {});
    batch.stop('c');
    await after(300);
    expect(state.fills).toBe(0);
  });

  it('fills against the newest message, where the applicant is looking', async () => {
    const seen = [];
    const batch = createBatcher({
      quietMs: 40,
      fill: async (ctx) => seen.push(ctx.at),
    });
    batch.arrived('c', { at: 'first' });
    batch.arrived('c', { at: 'last' });
    await after(200);
    expect(seen).toEqual(['last']);
  });
});

describe('nothing waits for ever', () => {
  it('gives up on a fill that never returns', async () => {
    // A browser that stops answering left the applicant waiting with no
    // message and no error, for hours.
    const batch = createBatcher({
      quietMs: 30,
      fillTimeoutMs: 80,
      fill: () => new Promise(() => {}),
    });
    batch.arrived('c', {});
    await after(300);
    expect(batch.busy('c')).toBe(false);
  });

  it('fills again for the next batch after giving up on one', async () => {
    let tries = 0;
    const batch = createBatcher({
      quietMs: 30,
      fillTimeoutMs: 80,
      fill: () => {
        tries += 1;
        return tries === 1 ? new Promise(() => {}) : Promise.resolve();
      },
    });
    batch.arrived('c', {});
    await after(250);
    batch.arrived('c', {});
    await after(250);
    expect(tries).toBe(2);
  });
});
