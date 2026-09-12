// evisa-start.mjs
//
// Getting the bot onto the network, and staying patient about it.
//
// Two things stand between a started process and a polling bot, and neither
// is a fault worth dying of. A predecessor may still hold the poll, which
// Telegram answers with 409 until its request ends. And the network may
// simply not be there yet: a machine that has just woken, a connection that
// drops mid-handshake. Both pass on their own if something waits.
//
// The command menu is neither. It is a convenience — every command answers
// whether or not Telegram was ever told about it — so it is attempted, and
// its failure is reported and stepped over, never fatal.

/**
 * The commands Telegram offers in its own menu, so the ways in are visible
 * without anybody being told them.
 *
 * Telegram rejects a hyphen in a command name, and rejects the whole list
 * with it, so these are the underscored spellings. The hyphenated ones are
 * still answered when typed.
 */
export const MENU = [
  { command: 'start', description: 'start over, and choose a language' },
  { command: 'fill_visa', description: 'fill in an e-visa application' },
  {
    command: 'download_visa',
    description: 'fetch a filed one: form, receipt, visa',
  },
  { command: 'arrival', description: 'the pre-arrival declaration' },
  { command: 'stop', description: 'stop, and close the browser window' },
];

/** The network being unreachable, as opposed to Telegram refusing us. */
const NETWORK_FAULTS = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'];

/**
 * Whether a failure is the network, as against an answer from Telegram.
 *
 * grammY wraps the underlying fetch failure, so the code sits one level in;
 * it is read from either place, since which one depends on how far the
 * request got.
 */
export function isNetworkFault(error) {
  const code = error?.error?.code ?? error?.code;
  return NETWORK_FAULTS.includes(code);
}

/** Whether Telegram says another poller still holds the token. */
export function isPollConflict(error) {
  return error?.error_code === 409;
}

/**
 * Starts polling, waiting out a predecessor and a missing network.
 *
 * The menu is registered first and never fatally: see above. Everything
 * else is retried on its own schedule — a 409 clears in about half a
 * minute, while a network may be minutes away, so it is given longer.
 */
export async function startPolling({
  setCommands,
  start,
  commands,
  say = console.log,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  conflictTries = 12,
  networkTries = 60,
  conflictPause = 5000,
  networkPause = 10000,
} = {}) {
  try {
    await setCommands(commands);
  } catch (error) {
    say(`the command menu was not registered: ${error.message}`);
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await start();
    } catch (error) {
      if (isPollConflict(error) && attempt <= conflictTries) {
        say('another instance still holds the poll; retrying in 5 s');
        await wait(conflictPause);
        continue;
      }
      if (isNetworkFault(error) && attempt <= networkTries) {
        say(`cannot reach Telegram (${error.message}); retrying in 10 s`);
        await wait(networkPause);
        continue;
      }
      throw error;
    }
  }
}
