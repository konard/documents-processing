import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';

const runner = readFileSync('src/evisa-bot-run.mjs', 'utf8');

describe('nothing fills or sends the form on its own', () => {
  it('fills only when something arrived from the applicant', () => {
    // The quiet timer is the one thing that starts a fill, and it is armed
    // where a message or a document has just been taken in.
    // Two call sites: a text message and a document. The third match is the
    // declaration itself.
    const armed = runner.match(/^\s+armIdleFill\(ctx, chatId\);$/gm) ?? [];
    expect(armed.length).toBe(2);
  });

  it('does not fill the form again when a review page comes up empty', () => {
    // The site's own fetch fails now and then. Filling again on its behalf
    // guesses at what the applicant wants; the form as they left it stands.
    const refill = runner.slice(
      runner.indexOf('async function refillAfterEmptyReview')
    );
    const body = refill.slice(0, refill.indexOf('\n}\n'));
    expect(body.includes('fillNow')).toBe(false);
    expect(body.includes('reopenForm')).toBe(false);
  });

  it('sends nothing when a fill wrote what the last one wrote', () => {
    // A field the site refuses stays refused, so the same form is not sent
    // over and over; the applicant is told which field and asked.
    expect(runner.includes('session.lastFill')).toBe(true);
    expect(runner.includes('tellWhatIsStuck')).toBe(true);
  });

  it('fills once when several messages arrive together', () => {
    // Three messages arriving while a slow fill runs each armed a timer, and
    // each timer queued another fill behind the first: three forms sent for
    // one set of documents. A request made while one is queued joins it.
    expect(runner.includes('session.fillQueued')).toBe(true);
    const joins = runner.slice(runner.indexOf('if (session.fillQueued)'));
    expect(joins.slice(0, 200).includes('return session.fillChain')).toBe(true);
  });

  it('names what asked for each fill, so a stray one can be traced', () => {
    for (const reason of ['quiet timer', 'confirmation', '/fill']) {
      expect(`${reason}:${runner.includes(reason)}`).toBe(`${reason}:true`);
    }
  });

  it('opens the quiet window when a message lands, not when it is read', () => {
    // A passport takes the better part of a minute to read. Arming the window
    // only after that let the window of the message before it run out, and the
    // form was filled while later messages were still being read.
    const handlers = runner.slice(runner.indexOf("bot.on(['message:photo'"));
    expect(
      handlers.slice(0, 600).includes('armIdleFill(ctx, ctx.chat.id)')
    ).toBe(true);
  });

  it('reads documents at the same time, and fills after all of them', () => {
    // Forwarded documents land in the same second. Each is read at once, and
    // the fill waits for the quiet window with no reading left running.
    const batch = readFileSync('src/evisa-batch.mjs', 'utf8');
    expect(batch.includes('state.reading.size')).toBe(true);
    // A reading registers with the batcher, so the window waits for it.
    expect(runner.includes('batch.reading(ctx.chat.id')).toBe(true);
  });

  it('lets a correction unstick the form', () => {
    // Whatever the applicant sends next is worth filling and showing again.
    const cleared = runner.match(/session\.lastFill = null/g) ?? [];
    expect(cleared.length >= 2).toBe(true);
    const untold = runner.match(/session\.toldWhatIsStuck = false/g) ?? [];
    expect(untold.length >= 2).toBe(true);
  });
});

describe('the language the applicant chose', () => {
  it('outlives an application, since starting another is not a change of language', async () => {
    // /visa begins a new application and clears the session with it. The
    // language is not part of an application: it is the applicant's own
    // choice, made once, and answering them in English after they picked
    // Russian is the bot forgetting something it was told.
    const { createSessionStore } = await import('../src/evisa-bot.mjs');
    const sessions = createSessionStore();
    const session = sessions.get(1);
    session.language = 'ru';
    session.languageChosen = true;
    session.data = { surname: 'TRAVELLER' };

    sessions.clear(1);
    const after = sessions.get(1);
    expect(after.language).toBe('ru');
    // And the application itself is gone, which is what clearing is for.
    expect(after.data).toEqual({});
  });

  it('is read back from the store when a session has none of its own', async () => {
    // A restart of the bot empties memory; the store is where the choice
    // lives, so the first message after one is still answered in it.
    const { createSessionStore } = await import('../src/evisa-bot.mjs');
    const { rememberedLanguage } = await import('../src/evisa-commands.mjs');
    const session = createSessionStore().get(2);
    expect(session.language).toBe('en');
    expect(rememberedLanguage(session, () => 'ru')).toBe('ru');
    expect(session.languageChosen).toBe(true);
  });

  it('leaves a chat that never chose one to the default', async () => {
    const { createSessionStore } = await import('../src/evisa-bot.mjs');
    const { rememberedLanguage } = await import('../src/evisa-commands.mjs');
    const session = createSessionStore().get(3);
    expect(rememberedLanguage(session, () => null)).toBe('en');
    expect(session.languageChosen).toBe(undefined);
  });
});

describe('asking the bot to stop', () => {
  it('is a command, not a word caught among the rest', () => {
    // Reached through the text handler, "/stop" arrived after the quiet
    // window had already been opened for it — so asking the bot to stop was
    // also asking it to wait twenty seconds and then fill.
    const commands = readFileSync('src/evisa-commands.mjs', 'utf8');
    expect(commands.includes("for (const name of ['stop', 'cancel'])")).toBe(
      true
    );
    expect(commands.includes('bot.command(name, (ctx) => stopFilling(')).toBe(
      true
    );
  });

  it('does not open the quiet window on its way past', () => {
    // A word that means stopping is not a reason to start filling.
    const runner = readFileSync('src/evisa-bot-run.mjs', 'utf8');
    const handler = runner.slice(runner.indexOf("bot.on('message:text'"));
    const body = handler.slice(0, handler.indexOf('});'));
    expect(body.includes('if (!isCancellation(ctx.message.text))')).toBe(true);
  });

  it('is offered in the menu, so it can be found without being known', () => {
    const runner = readFileSync('src/evisa-bot-run.mjs', 'utf8');
    expect(runner.includes("command: 'stop'")).toBe(true);
  });
});

describe('the commands the bot answers to', () => {
  const commands = readFileSync('src/evisa-commands.mjs', 'utf8');
  const runner = readFileSync('src/evisa-bot-run.mjs', 'utf8');

  it('names each one for the half of the work it does', () => {
    // "/visa" said nothing about whether it filled an application or
    // fetched one already filed. Both old names still answer.
    expect(commands.includes("['fill_visa', 'fill-visa', 'visa']")).toBe(true);
    expect(
      runner.includes("['download_visa', 'download-visa', 'documents']")
    ).toBe(true);
  });

  it('offers the underscored names, the only ones Telegram takes', () => {
    // A hyphen in a name is refused, and the whole list goes with it.
    const listed = runner.slice(runner.indexOf('setMyCommands'));
    const block = listed.slice(0, listed.indexOf(']);'));
    expect(block.includes("command: 'fill_visa'")).toBe(true);
    expect(block.includes("command: 'download_visa'")).toBe(true);
    // The names themselves carry no hyphen; a description may.
    const names = [...block.matchAll(/command: '([^']+)'/g)].map((m) => m[1]);
    expect(names.filter((name) => name.includes('-'))).toEqual([]);
  });

  it('asks for the application number, and never assumes one', () => {
    // A chat is shared, and the last application filed in it is not always
    // the one being asked about: fetching somebody else's documents unasked
    // is worse than asking.
    const at = runner.indexOf("bot.command(['download_visa'");
    const body = runner.slice(at, runner.indexOf('});', at));
    expect(body.includes("store.read(chatId, 'applicationNumber')")).toBe(
      false
    );
    expect(body.includes('session.application?.applicationNumber')).toBe(false);
    expect(body.includes('documentsNeedNumber')).toBe(true);
  });

  it('asks for a lookup´s code in its own words', () => {
    // The form's captcha says the application is about to be filed, which
    // is not what a lookup does.
    const documents = readFileSync('src/evisa-documents.mjs', 'utf8');
    expect(documents.includes('strings.lookupCaptchaAsk')).toBe(true);
  });
});
