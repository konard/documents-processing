// evisa-commands.mjs
//
// The commands for a visa application: starting one, and stopping it.
//
// The checklist answers from what is already known, so it does not wait on a
// browser. The applicant is told what to send at once; the page opens behind
// that reply.
//
// The arrival card is not here. It is a different form on a different
// government site, filed at a different point in the trip, and it lived in
// this file only because its command reads like a sibling of /fill_visa.
// Sitting among the visa commands it was written without the language
// restore that every command here does, and answered a Russian chat in
// English. It now sits with the declaration it draws, in evisa-prearrival.

import { MODES, enterMode } from './evisa-mode.mjs';

/** Registers the visa commands on a bot. */
export function registerVisaCommands(bot, deps) {
  const {
    sessions,
    log,
    touch,
    pageFor,
    KNOWN_REQUIRED,
    readRequiredFields,
    describeChecklist,
    // What language to answer in, which outlives a session and the bot.
    speakTheirLanguage = (chatId) => sessions.get(chatId).language,
    // Asking for a visa starts one, whatever went before. An application
    // that stalled, or one already sent, is not something to add to: the
    // applicant said "visa" and means a new one.
    restartChat = async () => {},
    stopFilling = async () => {},
  } = deps;

  // Stopping is a command of its own. Reached through the text handler it
  // arrived after the quiet window had been opened, so asking the bot to
  // stop was also asking it to wait and then fill.
  for (const name of ['stop', 'cancel']) {
    bot.command(name, (ctx) => stopFilling(ctx, ctx.chat.id));
  }

  // Named for what it does: "/visa" said nothing about which half of the
  // work it was, filling an application or fetching one already filed.
  // Telegram's own menu takes no hyphen in a name — it refuses the whole
  // list — so fill_visa is the one it lists, and the other two are taken
  // for anyone who types them.
  bot.command(['fill_visa', 'fill-visa', 'visa'], async (ctx) => {
    const chatId = ctx.chat.id;
    log(chatId, '/fill-visa');
    await restartChat(chatId);
    touch(chatId);
    const session = enterMode(sessions.get(chatId), MODES.filling);
    session.language = speakTheirLanguage(chatId);
    // The checklist goes out at once. Opening a browser takes seconds, and
    // making the applicant wait on it before they are told what to send buys
    // nothing: they can be reading the list while the page loads behind it.
    const listed = ctx
      .reply(describeChecklist(KNOWN_REQUIRED, session.language))
      .catch((error) =>
        log(chatId, `the checklist did not send: ${error.message}`)
      );
    const opened = pageFor(chatId)
      .then(async (page) => {
        // What the form actually asks for now, in case it has changed since.
        const report = await readRequiredFields(page);
        const changed = report.unmapped.map((field) => field.label);
        if (changed.length) {
          log(
            chatId,
            `the form asks for something new: ${changed.join(' | ')}`
          );
        }
      })
      .catch((error) =>
        log(chatId, `the browser did not open: ${error.message}`)
      );
    await listed;
    // The browser goes on opening behind the reply; nothing waits on it.
    void opened;
  });
}

/**
 * The language a chat is answered in, read back when a session has none.
 *
 * A choice the applicant made outlives both the session and the bot, since
 * it is kept in the store and not in memory. So a new application, or a
 * restart of either, must not answer them in a language they never asked
 * for. Returns the language, and marks it as chosen when it came from there.
 */
export function rememberedLanguage(session, read) {
  if (!session.languageChosen) {
    const remembered = read();
    if (remembered) {
      session.language = remembered;
      session.languageChosen = true;
    }
  }
  return session.language;
}

/**
 * Keeps a chat in the language its applicant reads, message by message.
 *
 * A language the applicant chose stays chosen. Reading it afresh from every
 * message turns a Russian chat to English on a captcha code, which is digits
 * and says nothing about the language its writer speaks.
 */
export function languageFollower({ store, detectLanguage }) {
  return function followLanguage(ctx, session) {
    if (session.languageChosen) {
      return;
    }
    // A restart empties the sessions but not the store, so the first message
    // after one still answers in the language the applicant chose.
    const remembered = store.read(ctx.chat.id, 'language');
    if (remembered) {
      session.language = remembered;
      session.languageChosen = true;
      return;
    }
    session.language = detectLanguage(
      ctx.message.text,
      ctx.from?.language_code
    );
  };
}
