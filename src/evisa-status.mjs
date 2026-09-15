// evisa-status.mjs
//
// The "typing" line under the bot's name, kept up while it works.
//
// Telegram clears a chat action after five seconds and whenever the bot sends
// a message, so it has to be renewed for as long as the work runs. A status
// says the bot is busy without adding a message the applicant has to scroll
// past — and a gap in it reads as a bot that has stopped, so the gaps are
// worth knowing about and are logged.

/**
 * How many renewal gaps may pass before the chat is showing nothing.
 *
 * Telegram clears a chat action about five seconds after the one it last
 * took, and the status is renewed every three, so a gap of much under two
 * renewals is covered and anything past that is the chat gone quiet. Held as
 * a multiple of the gap so a test can run the cycle in milliseconds and mean
 * the same thing by it.
 */
export const SILENT_AFTER = 5 / 3;

/**
 * Shows a status in the chat until the returned function is called.
 *
 * Telegram clears a chat action after five seconds, and again whenever the
 * bot sends a message, so it is renewed every three for as long as the work
 * runs. A status says the bot is busy without adding a message the applicant
 * then has to scroll past. The first failure to send it is logged, since a
 * status that silently stops looks like a bot that has.
 */
export function showStatus(
  ctx,
  action,
  log = () => {},
  // How often the status is renewed, and how long one send is waited for.
  // Named so a test can run the whole cycle in a moment.
  { everyMs = 3000, waitMs = 2500 } = {}
) {
  let stopped = false;
  let failed = false;
  let sent = 0;
  let slowest = 0;
  // The longest the chat went with no renewal landing, and when the last one
  // did. Telegram clears the status a few seconds after the last one it got,
  // so this — not a count against a clock — is what the chat actually saw.
  let widestGap = 0;
  const chatId = ctx.chat?.id;
  const startedAt = Date.now();
  let landedAt = startedAt;
  // Every deadline has a resolver and a handle, so stopping wakes the loop
  // immediately and retires the active cadence timer.
  const pendingWaits = new Set();
  const waitFor = (ms, value) => {
    let timer = null;
    let settled = false;
    let settlePromise;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      pendingWaits.delete(finish);
      settlePromise(value);
    };
    const promise = new Promise((resolve) => {
      settlePromise = resolve;
      timer = setTimeout(finish, ms);
      timer.unref?.();
    });
    pendingWaits.add(finish);
    return { promise, finish };
  };
  const send = async () => {
    const at = Date.now();
    try {
      // Bounded on its own: the bot's client waits ninety seconds for a call,
      // and this loop awaits it. One slow send would stop the renewals for
      // that whole time, and Telegram clears the status after five seconds —
      // so the chat would go quiet with nothing failing and nothing logged.
      // Which of the two finished first is the whole answer: a send that came
      // back reached the chat, and one still running when the wait was up did
      // not — yet. Racing them without asking who won counted every hung send
      // as a renewal the chat had seen.
      // The send is watched for failure whoever wins the race: one that fails
      // after the wait is up would otherwise reject with nobody holding it.
      const sending = ctx.replyWithChatAction(action);
      sending.catch(() => {});
      const late = waitFor(waitMs, false);
      let landed;
      try {
        landed = await Promise.race([sending.then(() => true), late.promise]);
      } finally {
        late.finish();
      }
      const now = Date.now();
      slowest = Math.max(slowest, now - at);
      if (!landed) {
        return;
      }
      sent += 1;
      widestGap = Math.max(widestGap, now - landedAt);
      landedAt = now;
    } catch (error) {
      if (!failed) {
        failed = true;
        log(chatId, `chat action "${action}" failed: ${error.message}`);
      }
    }
  };
  (async () => {
    let due = Date.now();
    while (!stopped) {
      await send();
      // Renewed on a fixed cadence, not every "gap plus however long the last
      // send took". Sleeping the full gap after each send lets the send's own
      // time accumulate, and a minute of work drifts far enough behind that
      // the count comes up short of the clock.
      if (stopped) {
        break;
      }
      due += everyMs;
      await waitFor(Math.max(0, due - Date.now())).promise;
    }
  })();
  return () => {
    stopped = true;
    for (const finish of [...pendingWaits]) {
      finish();
    }
    // Said once at the end, so a status that stopped short of the work can be
    // seen in the log beside the work it was meant to cover.
    const now = Date.now();
    const held = Math.round((now - startedAt) / 1000);
    const gap = Math.max(widestGap, now - landedAt);
    // Telegram clears the status a few seconds after the last renewal it
    // took, so a gap wider than that is one the chat really saw as a bot gone
    // quiet. Counting renewals against a clock instead called it a gap every
    // time a send was slow, even though the next one landed well inside the
    // window and the chat never stopped showing anything.
    if (gap > everyMs * SILENT_AFTER) {
      log(
        chatId,
        `status "${action}" held ${held}s with a ${Math.round(gap / 1000)}s ` +
          `gap in it (${sent} renewals, slowest ${slowest}ms): the chat saw gaps`
      );
    }
  };
}

/**
 * Keeps one status per chat, so it can be put out from anywhere.
 *
 * "Stop" has to stop the typing as well as the work: a bot that says it has
 * stopped and goes on typing has not stopped, as far as the applicant can
 * tell. Raising a second status for a chat puts out the first, since only one
 * is ever shown and two loops beside each other overwrite one another.
 */
export function trackStatuses(raise, log) {
  const held = new Map();

  const clearStatus = (chatId) => {
    const stop = held.get(chatId);
    if (stop) {
      held.delete(chatId);
      stop();
    }
  };

  const showStatus = (ctx, action) => {
    const chatId = ctx.chat?.id;
    clearStatus(chatId);
    const stop = raise(ctx, action, log);
    held.set(chatId, stop);
    return () => {
      if (held.get(chatId) === stop) {
        held.delete(chatId);
      }
      stop();
    };
  };

  return { showStatus, clearStatus };
}
