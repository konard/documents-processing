// evisa-commands.mjs
//
// The two commands that only read: the checklist for a visa application, and
// the draft of the pre-arrival declaration.
//
// Both answer from what is already known, so neither waits on a browser. The
// applicant is told what to send at once; the page opens behind that reply.

/** Registers /visa and /arrival on a bot. */
export function registerVisaCommands(bot, deps) {
  const {
    sessions,
    log,
    touch,
    pageFor,
    KNOWN_REQUIRED,
    readRequiredFields,
    describeChecklist,
    describeDeclaration,
    MESSAGES,
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
    const session = sessions.get(chatId);
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

  bot.command('arrival', async (ctx) => {
    const chatId = ctx.chat.id;
    log(chatId, '/arrival');
    touch(chatId);
    const session = sessions.get(chatId);
    const strings = MESSAGES[session.language];
    const { buildDeclaration, fullNameOf } =
      await import('./evisa-prearrival.mjs');
    const applicant = {
      ...(session.data ?? {}),
      fullName: fullNameOf(session.data ?? {}),
    };
    const { values, missing } = buildDeclaration(applicant);
    await ctx.reply(strings.arrivalIntro);
    await ctx.reply(describeDeclaration(values, missing, session.language), {
      parse_mode: 'HTML',
    });
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
