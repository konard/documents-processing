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
  const chatId = ctx.chat?.id;
  const startedAt = Date.now();
  const send = async () => {
    const at = Date.now();
    try {
      // Bounded on its own: the bot's client waits ninety seconds for a call,
      // and this loop awaits it. One slow send would stop the renewals for
      // that whole time, and Telegram clears the status after five seconds —
      // so the chat would go quiet with nothing failing and nothing logged.
      await Promise.race([
        ctx.replyWithChatAction(action),
        new Promise((resolve) => {
          const late = setTimeout(resolve, waitMs);
          late.unref?.();
        }),
      ]);
      sent += 1;
      slowest = Math.max(slowest, Date.now() - at);
    } catch (error) {
      if (!failed) {
        failed = true;
        log(chatId, `chat action "${action}" failed: ${error.message}`);
      }
    }
  };
  (async () => {
    while (!stopped) {
      await send();
      await new Promise((resolve) => {
        const next = setTimeout(resolve, everyMs);
        next.unref?.();
      });
    }
  })();
  return () => {
    stopped = true;
    // Said once at the end, so a status that stopped short of the work can be
    // seen in the log beside the work it was meant to cover.
    const held = Math.round((Date.now() - startedAt) / 1000);
    const expected = Math.floor((Date.now() - startedAt) / everyMs);
    // One renewal behind is the ordinary rounding of a loop against a clock.
    // Two or more means the chat was left showing nothing for a while.
    if (expected >= 2 && sent < expected - 1) {
      log(
        chatId,
        `status "${action}" held ${held}s but sent only ${sent} of about ` +
          `${expected} renewals (slowest ${slowest}ms): the chat saw gaps`
      );
    }
  };
}
