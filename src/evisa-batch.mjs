// evisa-batch.mjs
//
// One fill for everything an applicant sends, however they send it.
//
// Documents are forwarded in a batch, so five messages land in the same
// second. Each is worth reading at once — a passport takes the better part of
// a minute — but the form must be filled once, after the last of them, with
// everything on it. Filling twice types over a page that is already being
// typed into.
//
// So a chat has one runner. Work arriving marks the chat busy and pushes the
// quiet window out; the runner waits for the window to pass with nothing new
// arriving and nothing still being read, then fills, once. Anything that
// arrives during a fill is not lost: it opens the window again and is filled
// after that one finishes, still one fill at a time.

/**
 * Builds the batching for a bot.
 *
 * `fill` is what runs when a chat has been quiet, `onIdle` names the moment
 * for a log line, and `now` is the clock, which a test replaces.
 */
export function createBatcher({
  quietMs,
  fill,
  fillTimeoutMs = 10 * 60 * 1000,
  log = () => {},
  now = () => Date.now(),
  wait = (ms) =>
    new Promise((resolve) => {
      // Unreferenced: a chat waiting out its window must not keep a process
      // alive that has nothing else to do.
      setTimeout(resolve, ms).unref?.();
    }),
}) {
  /** What is in flight for each chat. */
  const chats = new Map();

  const stateOf = (chatId) => {
    if (!chats.has(chatId)) {
      chats.set(chatId, {
        // When the window last moved, so the runner knows how long to wait.
        touchedAt: 0,
        // Readings running now. The window is not over while any remain.
        reading: new Set(),
        // The runner, while one is going. There is never a second.
        running: null,
        // Set while a fill is under way, so a message arriving during one
        // is filled after it finishes, never beside it.
        filling: false,
        // The most recent message, which is what a reply is sent against.
        ctx: null,
        stopped: false,
      });
    }
    return chats.get(chatId);
  };

  /**
   * Runs until the chat has been quiet for the window with nothing left to
   * read, then fills. One runner per chat, so one fill at a time.
   */
  const run = async (chatId) => {
    const state = stateOf(chatId);
    for (;;) {
      // Wait out whatever is left of the window, counted from the last
      // thing that arrived, so a batch of forwarded messages extends it.
      let left = state.touchedAt + quietMs - now();
      while (left > 0) {
        await wait(left);
        left = state.touchedAt + quietMs - now();
      }
      // A reading still going means the window is not really over: filling
      // now would put a form up without the passport on it.
      if (state.reading.size) {
        await Promise.all([...state.reading]).catch(() => {});
        continue;
      }
      if (state.stopped) {
        return;
      }
      state.filling = true;
      const before = state.touchedAt;
      // What the fill is about to be told to do. A message landing while it
      // runs is checked against this, so a correction reaches the same fill
      // when it still can.
      state.fillingSince = now();
      try {
        // A browser that stops answering must not leave the chat waiting for
        // ever: a fill has a deadline, and the runner goes on past it.
        let late = null;
        await Promise.race([
          fill(state.ctx, chatId),
          new Promise((resolve) => {
            late = setTimeout(() => {
              log(chatId, 'the fill took too long; giving up on it');
              resolve();
            }, fillTimeoutMs);
            late.unref?.();
          }),
        ]);
        clearTimeout(late);
      } catch (error) {
        log(chatId, `filling failed: ${error.message}`);
      } finally {
        state.filling = false;
      }
      // Nothing arrived while that fill ran, so there is nothing to fill.
      if (state.touchedAt === before) {
        return;
      }
      // Something did arrive. It gets the same quiet window as anything
      // else, so a burst landing during a fill is still filled once.
      log(chatId, 'more arrived while filling; waiting out its window');
    }
  };

  return {
    /**
     * Takes in something that arrived: the window moves, and the runner is
     * started if it is not already going.
     */
    arrived(chatId, ctx) {
      const state = stateOf(chatId);
      state.stopped = false;
      state.touchedAt = now();
      // A reply goes against the newest message, so it lands at the bottom
      // of the chat where the applicant is looking.
      state.ctx = ctx ?? state.ctx;
      if (!state.running) {
        state.running = run(chatId).finally(() => {
          state.running = null;
        });
      }
      return state.running;
    },

    /**
     * Registers a reading, so the window is not considered over until it is
     * done. Whatever it resolves to is passed through.
     */
    reading(chatId, work) {
      const state = stateOf(chatId);
      const running = Promise.resolve().then(work);
      const held = running.catch(() => {});
      state.reading.add(held);
      held.finally(() => state.reading.delete(held));
      return running;
    },

    /** Stops a chat's runner, which is what /reset and a shutdown mean. */
    stop(chatId) {
      const state = chats.get(chatId);
      if (state) {
        state.stopped = true;
        state.touchedAt = 0;
      }
    },

    /** Whether a chat is waiting to fill or filling now. */
    busy(chatId) {
      const state = chats.get(chatId);
      return Boolean(state && (state.running || state.filling));
    },

    /** Forgets a chat entirely. */
    forget(chatId) {
      chats.delete(chatId);
    },
  };
}

/**
 * The batcher a bot uses, with the typing status kept up while it waits.
 *
 * The applicant sees "typing" from the moment their first message lands until
 * the filled form appears, which is what the wait looks like from their side.
 */
export function createFillBatcher({ quietMs, log, fill }) {
  // Nothing to disarm: the quiet window is the batcher's own, and the status
  // belongs to the fill. Kept so the callers that end a chat still read the
  // same, and so ending one twice is harmless.
  const disarmIdleFill = () => {};

  const batch = createBatcher({
    quietMs,
    log,
    // The fill puts its own status up and takes it down again, and it is the
    // only thing that does. Two owners of one indicator is one too many: the
    // fill began by disarming this one, so the status went out at the very
    // moment the work started and the chat sat silent through all of it.
    fill,
  });

  /** Takes in something that arrived. */
  const armIdleFill = (ctx, chatId) => {
    batch.arrived(chatId, ctx);
  };

  return { batch, armIdleFill, disarmIdleFill };
}
