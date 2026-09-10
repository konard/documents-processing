import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';

const runner = readFileSync('src/evisa-bot-run.mjs', 'utf8');

describe('nothing fills or sends the form on its own', () => {
  it('fills only when something arrived from the applicant', () => {
    // The quiet timer is the one thing that starts a fill, and it is armed
    // where a message or a document has just been taken in.
    // Two call sites: a text message and a document. The third match is the
    // declaration itself.
    const armed = runner.match(/^\s+armIdleFill\(ctx, chatId\);$/gm) ?? [];
    expect(armed.length).toBe(2);
  });

  it('does not fill the form again when a review page comes up empty', () => {
    // The site's own fetch fails now and then. Filling again on its behalf
    // guesses at what the applicant wants; the form as they left it stands.
    const refill = runner.slice(
      runner.indexOf('async function refillAfterEmptyReview')
    );
    const body = refill.slice(0, refill.indexOf('\n}\n'));
    expect(body.includes('fillNow')).toBe(false);
    expect(body.includes('reopenForm')).toBe(false);
  });

  it('sends nothing when a fill wrote what the last one wrote', () => {
    // A field the site refuses stays refused, so the same form is not sent
    // over and over; the applicant is told which field and asked.
    expect(runner.includes('session.lastFill')).toBe(true);
    expect(runner.includes('tellWhatIsStuck')).toBe(true);
  });

  it('fills once when several messages arrive together', () => {
    // Three messages arriving while a slow fill runs each armed a timer, and
    // each timer queued another fill behind the first: three forms sent for
    // one set of documents. A request made while one is queued joins it.
    expect(runner.includes('session.fillQueued')).toBe(true);
    const joins = runner.slice(runner.indexOf('if (session.fillQueued)'));
    expect(joins.slice(0, 200).includes('return session.fillChain')).toBe(true);
  });

  it('names what asked for each fill, so a stray one can be traced', () => {
    for (const reason of ['quiet timer', 'confirmation', '/fill']) {
      expect(`${reason}:${runner.includes(reason)}`).toBe(`${reason}:true`);
    }
  });

  it('opens the quiet window when a message lands, not when it is read', () => {
    // A passport takes the better part of a minute to read. Arming the window
    // only after that let the window of the message before it run out, and the
    // form was filled while later messages were still being read.
    const handlers = runner.slice(runner.indexOf("bot.on(['message:photo'"));
    expect(
      handlers.slice(0, 600).includes('armIdleFill(ctx, ctx.chat.id)')
    ).toBe(true);
  });

  it('reads documents at the same time, and fills after all of them', () => {
    // Forwarded documents land in the same second. Each is read at once, and
    // the fill waits for the quiet window with no reading left running.
    const batch = readFileSync('src/evisa-batch.mjs', 'utf8');
    expect(batch.includes('state.reading.size')).toBe(true);
    // A reading registers with the batcher, so the window waits for it.
    expect(runner.includes('batch.reading(ctx.chat.id')).toBe(true);
  });

  it('lets a correction unstick the form', () => {
    // Whatever the applicant sends next is worth filling and showing again.
    const cleared = runner.match(/session\.lastFill = null/g) ?? [];
    expect(cleared.length >= 2).toBe(true);
    const untold = runner.match(/session\.toldWhatIsStuck = false/g) ?? [];
    expect(untold.length >= 2).toBe(true);
  });
});
