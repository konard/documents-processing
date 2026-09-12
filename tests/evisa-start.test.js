import { describe, it, expect } from 'test-anywhere';
import {
  startPolling,
  isNetworkFault,
  isPollConflict,
} from '../src/evisa-start.mjs';

/** A grammY HttpError as it actually arrives: the cause wrapped one level in. */
const timedOut = () =>
  Object.assign(new Error("Network request for 'setMyCommands' failed!"), {
    error: Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' }),
  });

const conflict = () =>
  Object.assign(new Error('Conflict'), { error_code: 409 });

/** Runs without the waiting, so a retry test is not a slow test. */
const quickly = { wait: async () => {}, say: () => {} };

describe('getting the bot onto the network', () => {
  it('starts even when the command menu cannot be registered', async () => {
    // The menu is a convenience. A timeout registering it once killed the
    // whole bot at startup, which is the failure this guards.
    let started = false;
    await startPolling({
      ...quickly,
      setCommands: async () => {
        throw timedOut();
      },
      start: async () => {
        started = true;
      },
    });
    expect(started).toBe(true);
  });

  it('says so when the menu was not registered', async () => {
    const said = [];
    await startPolling({
      ...quickly,
      say: (line) => said.push(line),
      setCommands: async () => {
        throw timedOut();
      },
      start: async () => {},
    });
    expect(said.some((line) => line.includes('menu was not registered'))).toBe(
      true
    );
  });

  it('waits out a network that is not there yet', async () => {
    let tries = 0;
    await startPolling({
      ...quickly,
      setCommands: async () => {},
      start: async () => {
        tries += 1;
        if (tries < 3) {
          throw timedOut();
        }
      },
    });
    expect(tries).toBe(3);
  });

  it('waits out a predecessor still holding the poll', async () => {
    let tries = 0;
    await startPolling({
      ...quickly,
      setCommands: async () => {},
      start: async () => {
        tries += 1;
        if (tries < 2) {
          throw conflict();
        }
      },
    });
    expect(tries).toBe(2);
  });

  it('gives up on a network that never comes back', async () => {
    let failed = null;
    await startPolling({
      ...quickly,
      networkTries: 3,
      setCommands: async () => {},
      start: async () => {
        throw timedOut();
      },
    }).catch((error) => {
      failed = error;
    });
    expect(failed === null).toBe(false);
  });

  it('does not retry a refusal, which waiting will not mend', async () => {
    // A bad token answers 401. Retrying it sixty times helps nobody.
    let tries = 0;
    await startPolling({
      ...quickly,
      setCommands: async () => {},
      start: async () => {
        tries += 1;
        throw Object.assign(new Error('Unauthorized'), { error_code: 401 });
      },
    }).catch(() => {});
    expect(tries).toBe(1);
  });

  it('knows a network fault from a refusal', () => {
    expect(isNetworkFault(timedOut())).toBe(true);
    expect(isNetworkFault({ code: 'ECONNRESET' })).toBe(true);
    expect(isNetworkFault(conflict())).toBe(false);
    expect(isNetworkFault(undefined)).toBe(false);
    expect(isPollConflict(conflict())).toBe(true);
    expect(isPollConflict(timedOut())).toBe(false);
  });
});
