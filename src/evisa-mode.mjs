// evisa-mode.mjs
//
// Which of its jobs a chat is doing.
//
// The bot does three separate things: it fills in an application, it fetches
// one already filed, and it prepares the pre-arrival declaration. They share
// a chat and a browser but nothing else, and telling them apart was left to
// whichever flags happened to be set — `lookingUp` for one, `gathering` for
// another, `stage` for a third.
//
// That is how /download_visa came to fill in a visa form. Every step of a
// lookup is a text message: the command, the details the site asks for, the
// captcha code. The handler that takes text in armed a fill before anything
// had looked at the message, so each step queued a fill of a blank form, and
// each fix named one more flag to exclude.
//
// A chat is in one mode at a time, and it says so. What a message means
// follows from the mode, not from guessing at the message.

/** The jobs a chat can be doing. */
export const MODES = {
  /** Nothing in hand: the next command decides. */
  idle: 'idle',
  /** Filling in an application, which is what documents and details feed. */
  filling: 'filling',
  /** Fetching an application already filed. Fills nothing in. */
  lookingUp: 'lookingUp',
  /** The pre-arrival declaration, after a visa is granted. */
  arriving: 'arriving',
};

/** The mode a chat is in, defaulting to filling for a chat that has begun one. */
export function modeOf(session = {}) {
  return session.mode ?? MODES.idle;
}

/** Puts a chat into a mode, and clears what the last one was holding. */
export function enterMode(session, mode) {
  session.mode = mode;
  if (mode !== MODES.lookingUp) {
    session.lookingUp = null;
    session.gathering = null;
  }
  return session;
}

/**
 * Whether a document means the chat has begun filling an application.
 *
 * A passport is not evidence of which job a chat is doing. Every job here
 * wants one: the application form, and the pre-arrival declaration, which
 * asks for the passport, the visa and the ticket by name. Read as a reason
 * to fill an application, the documents somebody sent for their arrival card
 * opened the form and typed their passport onto it.
 *
 * So a document says which job only when no command has. A chat already
 * fetching or arriving keeps the job it was told; one that has begun
 * nothing takes a document as the start of an application, which is what it
 * usually is.
 */
export function documentBeginsFilling(session = {}) {
  return modeOf(session) === MODES.idle;
}

/**
 * Whether a text message is a detail for the application form.
 *
 * Only a chat that is filling one has details to take. A lookup's messages
 * are its own — an application number, an email, a captcha code — and a
 * chat that has begun nothing is answered by the command it sends.
 */
export function fillsTheForm(session = {}) {
  return modeOf(session) === MODES.filling;
}

/**
 * Whether a captcha code belongs to the lookup or to the form.
 *
 * Both ask for one, and a six-digit code looks the same either way; the
 * mode is what says which is waiting for it.
 */
export function captchaIsForLookup(session = {}) {
  return modeOf(session) === MODES.lookingUp && Boolean(session.lookingUp);
}

/**
 * Wraps a fill so it happens only for a chat whose job is filling.
 *
 * The last word on whether a form gets filled. Everything that asks for one
 * is upstream of here and has been wrong before: a chat fetching documents
 * has no application to fill in, and one that has done nothing has no
 * details to fill it with, so both get a blank form typed at and
 * photographed. The mode settles it in one place, whatever asked.
 */
export function onlyWhenFilling({ sessions, log, fill, arrive = null }) {
  return (ctx, chatId) => {
    const session = sessions.get(chatId);
    if (fillsTheForm(session)) {
      return fill(ctx, chatId);
    }
    // A chat gathering documents for the declaration has an answer of its
    // own to give. Read in silence, a visa and a ticket left the traveller
    // looking at the list of everything still wanted, sent before either was
    // read: nothing was stuck, but nothing said so.
    if (arrive && modeOf(session) === MODES.arriving) {
      return arrive(ctx, chatId);
    }
    log(chatId, `nothing to fill: the chat is ${modeOf(session)}`);
    return Promise.resolve();
  };
}

/**
 * Refuses details that arrive after the site has taken the form.
 *
 * Where the mode says which job a chat is doing, the stage says how far
 * along that job is. Details sent past the form cannot reach it, so the
 * chat is told and a countdown is stopped: details are not a word to send.
 */
export function pastFormRefusal({ MESSAGES, log, settleCountdown }) {
  return async function refuseIfPastForm(ctx, session) {
    if ((session.stage ?? 'form') === 'form') {
      return false;
    }
    settleCountdown(ctx.chat.id, 'stop');
    log(ctx.chat.id, 'details received past the form; refused');
    await ctx.reply(MESSAGES[session.language].pastForm);
    return true;
  };
}
