// evisa-shutdown.mjs
//
// Closing down without leaving anybody wondering.
//
// A chat whose browser holds a half-filled form has to hear why the window
// went, and hear it while the window is still there. So each chat is told
// first, then the windows are closed, then the process goes — in that order,
// and with a limit on each step, since a browser that will not close must
// not keep the process alive for ever.

/**
 * Wires the signals that end a run, and gives back what they call.
 *
 * Everything it touches is passed in, so the order it does things in can be
 * read here and tested without a bot.
 */
export function onShutdown({
  browsers,
  sessions,
  MESSAGES,
  log,
  clearStatus,
  endChat,
  say,
  stopBot,
  onClosing = () => {},
  told = 3000,
  closed = 5000,
  exit = () => process.exit(0),
  signals = process,
}) {
  let closingDown = null;

  const shutDown = (why) => {
    if (closingDown) {
      return closingDown;
    }
    onClosing();
    closingDown = (async () => {
      console.log(`Shutting down (${why}); telling each chat and closing.`);
      const warned = [...browsers.keys()].map((chatId) => {
        clearStatus(chatId);
        const strings = MESSAGES[sessions.get(chatId).language] ?? MESSAGES.en;
        log(chatId, 'shutting down; the chat is told its browser closes');
        return say(chatId, strings.restarting).catch(() => {});
      });
      await Promise.race([
        Promise.all(warned),
        new Promise((resolve) => setTimeout(resolve, told)),
      ]);
      // Only now: the applicant has been told, so the window going is expected.
      const closing = Promise.all([...browsers.keys()].map(endChat));
      await Promise.race([
        closing,
        new Promise((resolve) => setTimeout(resolve, closed)),
      ]);
      await stopBot().catch(() => {});
      exit();
    })();
    return closingDown;
  };

  signals.on('SIGINT', () => shutDown('Ctrl+C'));
  signals.on('SIGTERM', () => shutDown('a stop signal'));
  return shutDown;
}
