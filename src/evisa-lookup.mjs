// evisa-lookup.mjs
//
// Gathering what the site's search page asks for before a window is opened.
//
// The page wants three things: the application number, the email the
// application was filed with, and the applicant's date of birth. It marks
// the first two required and refuses a search without them. The captcha is
// the fourth, and the only one a person must read off the screen.
//
// After a payment all three sit in the session, because this bot filed the
// application minutes earlier. Asked cold — a chat that has done nothing
// else, or a bot restarted since — none of them do, and a search opened
// with two fields empty cannot succeed. They are collected up front, and
// the browser opens when there is something to search with.

/**
 * Whether a message is a command, as against something said to the bot.
 *
 * Telegram marks a command with an entity at the very start of the text.
 * The text handler sees commands as well as ordinary messages, and taking
 * one for details puts a command's own words on the application form.
 */
export function isCommand(message = {}) {
  return (message.entities ?? []).some(
    (entity) => entity.type === 'bot_command' && entity.offset === 0
  );
}

/** What the search page needs, in the order it asks. */
export const LOOKUP_FIELDS = ['applicationNumber', 'email', 'dateOfBirth'];

/** An application number: E, six digits of date, three letters, then digits. */
const NUMBER = /\bE\d{6}[A-Z]{3}\d+\b/i;

/** A date as the site writes it, and as most people do. */
const DATE = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/;

/** An email, loosely: enough to tell one from a number or a date. */
const EMAIL = /[\w.+-]+@[\w.-]+\.\w+/;

/** The date written as the site wants it, with both parts padded. */
function asSiteDate(day, month, year) {
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

/**
 * Reads whichever of the three a message carries.
 *
 * Each is shaped unlike the others, so a message can hold all three in any
 * order, or one at a time across several messages, and nobody has to be
 * told a format.
 */
export function readLookupDetails(text) {
  const said = String(text ?? '');
  const found = {};
  const number = said.match(NUMBER);
  if (number) {
    found.applicationNumber = number[0].toUpperCase();
  }
  const email = said.match(EMAIL);
  if (email) {
    found.email = email[0];
  }
  const date = said.match(DATE);
  if (date) {
    const [, first, second, year] = date;
    // A day above twelve can only be a day, which settles the order; below
    // that the site's own order is assumed, as it is everywhere else here.
    const dayFirst = Number(first) > 12 || Number(second) <= 12;
    found.dateOfBirth = dayFirst
      ? asSiteDate(first, second, year)
      : asSiteDate(second, first, year);
  }
  return found;
}

/** Which of the three are still missing. */
export function stillNeeded(gathered = {}) {
  return LOOKUP_FIELDS.filter((field) => !gathered[field]);
}

/** Whether there is enough to open the search page. */
export function canSearch(gathered = {}) {
  return stillNeeded(gathered).length === 0;
}

/**
 * What is already known about an application, from the session and the store.
 *
 * A lookup straight after a payment needs no questions: the application was
 * filed by this bot and everything is to hand.
 */
export function whatIsKnown({ session = {}, remembered = {} } = {}) {
  const application = session.application ?? {};
  const data = session.data ?? {};
  return {
    applicationNumber: application.applicationNumber,
    email: application.email ?? remembered.email ?? data.email,
    dateOfBirth: application.dateOfBirth ?? data.dateOfBirth,
  };
}

/**
 * What to do about a half-gathered lookup: ask for the rest, or open it.
 *
 * Kept apart from the chat so the decision can be read on its own — nothing
 * here sends anything or touches a browser.
 */
export function whatToAsk(gathered, strings) {
  const missing = stillNeeded(gathered);
  if (!missing.length) {
    return { open: true, say: strings.documentsOpening };
  }
  if (missing.length === LOOKUP_FIELDS.length) {
    return { open: false, say: strings.documentsNeedNumber };
  }
  const named = {
    applicationNumber: strings.documentsNumberName,
    email: strings.documentsEmailName,
    dateOfBirth: strings.documentsBirthName,
  };
  return {
    open: false,
    say: strings.documentsStillNeed(missing.map((field) => named[field])),
  };
}

/**
 * Folds what a message said into the details in hand.
 *
 * A value given twice takes its later reading, so a mistyped number is put
 * right by sending it again.
 */
export function gather(sofar = {}, said = {}) {
  const next = { ...sofar };
  for (const field of LOOKUP_FIELDS) {
    if (said[field]) {
      next[field] = said[field];
    }
  }
  return next;
}

/**
 * The two halves of a lookup conversation, wired to a chat.
 *
 * Kept together because they are one exchange: the command starts it, and
 * every message after it adds to the same gathering until the site has
 * enough to search on.
 */
export function createLookup({
  sessions,
  MESSAGES,
  log,
  shown,
  lookUpApplication,
}) {
  /** Asks for whatever the search page still needs, and opens it when it can. */
  async function continueLookup(ctx, chatId) {
    const session = sessions.get(chatId);
    const gathered = session.gathering;
    const asked = whatToAsk(gathered, MESSAGES[session.language]);
    await ctx.reply(asked.say);
    if (!asked.open) {
      return;
    }
    session.gathering = null;
    log(chatId, `/download_visa for ${shown(gathered.applicationNumber)}`);
    await lookUpApplication(ctx, chatId, gathered.applicationNumber, gathered);
  }

  /**
   * Takes what a message holds towards a waiting lookup, if one is waiting.
   *
   * Reports whether it did, so the caller can stop: none of this belongs to
   * the application form.
   */
  async function tookLookupDetails(ctx, chatId, session) {
    if (!session.gathering) {
      return false;
    }
    const said = readLookupDetails(ctx.message.text);
    session.gathering = gather(session.gathering, said);
    await continueLookup(ctx, chatId);
    return true;
  }

  return { continueLookup, tookLookupDetails };
}
