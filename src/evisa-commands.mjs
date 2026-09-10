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
  } = deps;

  bot.command('visa', async (ctx) => {
    const chatId = ctx.chat.id;
    log(chatId, '/visa');
    touch(chatId);
    const session = sessions.get(chatId);
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
