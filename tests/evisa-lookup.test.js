import { describe, it, expect } from 'test-anywhere';
import {
  readLookupDetails,
  stillNeeded,
  canSearch,
  gather,
  whatIsKnown,
  createLookup,
} from '../src/evisa-lookup.mjs';
import { MODES, enterMode, fillsTheForm } from '../src/evisa-mode.mjs';

describe('gathering what a lookup needs', () => {
  it('reads all three out of one message, in any order', () => {
    const found = readLookupDetails(
      'E260908XXX0000000000 traveller@example.com 01/02/1990'
    );
    expect(found.applicationNumber).toBe('E260908XXX0000000000');
    expect(found.email).toBe('traveller@example.com');
    expect(found.dateOfBirth).toBe('01/02/1990');
    expect(canSearch(found)).toBe(true);
  });

  it('reads them just as well the other way round', () => {
    const found = readLookupDetails(
      '15.03.1985, sample@example.com, e260908xxx0000000000'
    );
    expect(found.applicationNumber).toBe('E260908XXX0000000000');
    expect(found.email).toBe('sample@example.com');
    expect(found.dateOfBirth).toBe('15/03/1985');
  });

  it('takes a day above twelve as the day, whatever the order', () => {
    expect(readLookupDetails('25/12/1990').dateOfBirth).toBe('25/12/1990');
    // Written the American way round, the day is still the twenty-fifth.
    expect(readLookupDetails('12/25/1990').dateOfBirth).toBe('25/12/1990');
  });

  it('says which of the three are missing', () => {
    expect(stillNeeded({})).toEqual([
      'applicationNumber',
      'email',
      'dateOfBirth',
    ]);
    expect(stillNeeded(readLookupDetails('E260908XXX0000000000'))).toEqual([
      'email',
      'dateOfBirth',
    ]);
    expect(canSearch(readLookupDetails('E260908XXX0000000000'))).toBe(false);
  });

  it('builds the three up across several messages', () => {
    // Nobody should have to send all three at once to be understood.
    let sofar = readLookupDetails('/download_visa');
    expect(canSearch(sofar)).toBe(false);
    sofar = gather(sofar, readLookupDetails('E260908XXX0000000000'));
    sofar = gather(sofar, readLookupDetails('traveller@example.com'));
    expect(canSearch(sofar)).toBe(false);
    sofar = gather(sofar, readLookupDetails('01/02/1990'));
    expect(canSearch(sofar)).toBe(true);
    expect(sofar.applicationNumber).toBe('E260908XXX0000000000');
  });

  it('lets a correction replace what was given before', () => {
    const first = readLookupDetails('E260908XXX0000000000');
    const fixed = gather(first, readLookupDetails('E260908XXX9999999999'));
    expect(fixed.applicationNumber).toBe('E260908XXX9999999999');
  });

  it('keeps what a message says nothing about', () => {
    const sofar = { applicationNumber: 'E260908XXX0000000000' };
    const next = gather(sofar, readLookupDetails('nothing useful here'));
    expect(next.applicationNumber).toBe('E260908XXX0000000000');
  });

  it('finds nothing in a message that holds nothing', () => {
    expect(readLookupDetails('hello')).toEqual({});
    expect(readLookupDetails('')).toEqual({});
    expect(readLookupDetails(undefined)).toEqual({});
  });

  it('needs no questions when the bot just filed the application', () => {
    // Straight after a payment everything is already to hand.
    const known = whatIsKnown({
      session: {
        application: {
          applicationNumber: 'E260908XXX0000000000',
          email: 'traveller@example.com',
          dateOfBirth: '01/02/1990',
        },
      },
    });
    expect(canSearch(known)).toBe(true);
  });

  it('falls back to the email the store remembers', () => {
    const known = whatIsKnown({
      session: { data: { dateOfBirth: '01/02/1990' } },
      remembered: { email: 'traveller@example.com' },
    });
    expect(known.email).toBe('traveller@example.com');
    // Without a number there is still nothing to search for.
    expect(canSearch(known)).toBe(false);
  });
});

describe('a second application number, after the first was fetched', () => {
  /** A chat as the fetch leaves it: documents sent, lookup still the job. */
  function afterAFetch() {
    const session = enterMode({ language: 'ru' }, MODES.lookingUp);
    // What the fetch sets: that search is answered, so no captcha is
    // outstanding, but the gathering is open again for the next number.
    session.lookingUp = null;
    session.gathering = {};
    return session;
  }

  it('starts the next lookup without the command being typed again', async () => {
    // One application is rarely the only one, and having to send
    // /download_visa between each is a step that says nothing.
    const session = afterAFetch();
    let searched = null;
    const { tookLookupDetails } = createLookup({
      sessions: { get: () => session },
      MESSAGES: { ru: {} },
      log: () => {},
      shown: (one) => one,
      lookUpApplication: async (ctx, chatId, number, gathered) => {
        searched = { number, gathered };
      },
    });
    const ctx = {
      chat: { id: 1 },
      message: {
        text: 'E260908XXX0000000000\n01/02/1990\ntraveller@example.com',
      },
      reply: async () => {},
    };
    const took = await tookLookupDetails(ctx, 1, session);
    expect(took).toBe(true);
    expect(searched.number).toBe('E260908XXX0000000000');
    expect(searched.gathered.email).toBe('traveller@example.com');
  });

  it('is not read as details for an application form', () => {
    // The mode is what decides, and a chat fetching documents is not filling
    // anything in. Read as form details instead, the application number
    // would be typed onto a blank form and photographed.
    expect(fillsTheForm(afterAFetch())).toBe(false);
  });
});
