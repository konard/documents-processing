// evisa-turns.mjs
//
// The order work runs in for one chat.
//
// Two things are true at once. What an applicant sends must be taken in in the
// order they sent it, so a correction never lands before the value it
// corrects. And reading a passport takes the better part of a minute, so two
// sent together are worth reading at the same time.
//
// So messages are taken in turn, readings run beside each other, and the
// quiet timer waits on both, filling the form once.

/** Builds the ordering helpers against a bot's own sessions. */
export function createTurns(sessions) {
  /**
   * Runs work for a chat beside whatever else is running for it, and keeps a
   * handle on all of it.
   *
   * Reading a passport is minutes of somebody's time when done one after
   * another and seconds when done together, so the readings overlap. `settled`
   * is what the quiet timer waits on: every reading that has been started.
   */
  function alongside(chatId, work) {
    const session = sessions.get(chatId);
    const running = Promise.resolve().then(work);
    session.reading = [...(session.reading ?? []), running.catch(() => {})];
    return running;
  }

  /** Everything a chat has started and not yet finished. */
  function settled(chatId) {
    const session = sessions.get(chatId);
    return Promise.all([
      session.queue ?? Promise.resolve(),
      ...(session.reading ?? []),
    ]).catch(() => {});
  }

  /**
   * Runs a chat's messages one at a time, in the order they arrived.
   *
   * Two photos sent together would otherwise be read at once and write their
   * fields over each other; a "стой" sent while a photo is being read must
   * take effect after the reading, not before the timer it is meant to stop
   * has even been set.
   */
  function inTurn(chatId, work) {
    const session = sessions.get(chatId);
    const turn = (session.queue ?? Promise.resolve()).then(work, work);
    session.queue = turn.catch(() => {});
    return turn;
  }

  return { inTurn, alongside, settled };
}
