import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';
import { MENU } from '../src/evisa-start.mjs';
import { whatToAsk } from '../src/evisa-lookup.mjs';
import { MESSAGES } from '../src/evisa-messages.mjs';

const runner = readFileSync('src/evisa-bot-run.mjs', 'utf8');

describe('nothing fills or sends the form on its own', () => {
  it('fills only when something arrived from the applicant', async () => {
    // The rule, whole: if the applicant sends nothing, the bot does nothing.
    // A fill runs against messages that arrived and have not been filled; a
    // fill of its own accord is the loop, and there is no counter for it.
    const { createBatcher } = await import('../src/evisa-batch.mjs');
    let fills = 0;
    const batch = createBatcher({
      quietMs: 0,
      fill: async () => {
        fills += 1;
      },
      wait: () => Promise.resolve(),
    });
    await batch.arrived(1, {});
    expect(fills).toBe(1);
    // Holding the window open is not a message, so it fills nothing.
    await batch.arrived(1, {}, { again: false });
    expect(fills).toBe(1);
    // A second message is a second fill, and no more than that.
    await batch.arrived(1, {});
    expect(fills).toBe(2);
  });

  it('does not fill again for work the fill itself reported', async () => {
    // Every handler ends by holding the window open, which used to push the
    // timestamp the runner watched: the fill finished, saw a newer stamp,
    // and filled again, for ever, sending the same blank form each time.
    const { createBatcher } = await import('../src/evisa-batch.mjs');
    let fills = 0;
    const batch = createBatcher({
      quietMs: 0,
      fill: async (ctx, chatId) => {
        fills += 1;
        // What the end of a handler does, while the fill is running.
        batch.arrived(chatId, {}, { again: false });
      },
      wait: () => Promise.resolve(),
    });
    await batch.arrived(1, {});
    expect(fills).toBe(1);
  });

  it('fills once more for a message that landed during a fill', async () => {
    // The other half: what the applicant sent while a fill ran is not lost.
    const { createBatcher } = await import('../src/evisa-batch.mjs');
    let fills = 0;
    const batch = createBatcher({
      quietMs: 0,
      fill: async (ctx, chatId) => {
        fills += 1;
        if (fills === 1) {
          batch.arrived(chatId, {});
        }
      },
      wait: () => Promise.resolve(),
    });
    await batch.arrived(1, {});
    expect(fills).toBe(2);
  });

  it('holds the window open for a reading that outlasts it', () => {
    // A passport takes longer to read than the window is wide. The reading
    // is what the fill waits for; it asks for no fill of its own.
    expect(runner.includes('holdIdleFill(ctx, chatId)')).toBe(true);
    // And the two places a fill is actually asked for are the two places a
    // message from the applicant lands: a text, and a document.
    const armed = runner.match(/^\s+armIdleFill\(ctx, ctx\.chat\.id\);$/gm);
    expect((armed ?? []).length).toBe(2);
  });

  it('fills nothing for a chat that is not filling anything in', async () => {
    // The last word, wherever the request came from: /download_visa fetches
    // a filed application, and a browser opened for one has no form on it.
    const { onlyWhenFilling, MODES, enterMode } =
      await import('../src/evisa-mode.mjs');
    const held = new Map();
    let fills = 0;
    const guarded = onlyWhenFilling({
      sessions: { get: (chatId) => held.get(chatId) },
      log: () => {},
      fill: () => {
        fills += 1;
      },
    });
    held.set(1, enterMode({}, MODES.lookingUp));
    await guarded({}, 1);
    expect(fills).toBe(0);
    held.set(2, {});
    await guarded({}, 2);
    expect(fills).toBe(0);
    held.set(3, enterMode({}, MODES.filling));
    await guarded({}, 3);
    expect(fills).toBe(1);
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
    // Armed in the handler itself, before the reading is handed to a worker,
    // which is what "when the message lands" means.
    const at = runner.indexOf("bot.on(['message:photo'");
    const handler = runner.slice(at, runner.indexOf('batch.reading(', at));
    expect(handler.includes('armIdleFill(ctx, ctx.chat.id)')).toBe(true);
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
    // A word that means stopping is not a reason to start filling, and
    // neither is a command: this handler sees those too.
    const runner = readFileSync('src/evisa-bot-run.mjs', 'utf8');
    const handler = runner.slice(runner.indexOf("bot.on('message:text'"));
    const body = handler.slice(0, handler.indexOf('\n});'));
    expect(body.includes('isCancellation(ctx.message.text)')).toBe(true);
    expect(body.includes('isCommand(ctx.message)')).toBe(true);
    // And a window opens only for a chat whose job is filling a form in.
    expect(body.includes('fillsTheForm(session)')).toBe(true);
  });

  it('is offered in the menu, so it can be found without being known', () => {
    expect(MENU.some((entry) => entry.command === 'stop')).toBe(true);
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
    const names = MENU.map((entry) => entry.command);
    expect(names.includes('fill_visa')).toBe(true);
    expect(names.includes('download_visa')).toBe(true);
    // The names themselves carry no hyphen; a description may.
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
  });

  it('asks for all three the search page wants, not the number alone', () => {
    // The site marks the number and the email required and refuses a search
    // without them, so a window opened on the number alone cannot succeed.
    const strings = MESSAGES.en;
    expect(whatToAsk({}, strings).open).toBe(false);
    expect(whatToAsk({}, strings).say).toBe(strings.documentsNeedNumber);
    const one = { applicationNumber: 'E260908XXX0000000000' };
    expect(whatToAsk(one, strings).open).toBe(false);
    expect(
      whatToAsk(one, strings).say.includes(strings.documentsEmailName)
    ).toBe(true);
    const all = { ...one, email: 'a@example.com', dateOfBirth: '01/02/1990' };
    expect(whatToAsk(all, strings).open).toBe(true);
  });

  it('asks for a lookup´s code in its own words', () => {
    // The form's captcha says the application is about to be filed, which
    // is not what a lookup does.
    const documents = readFileSync('src/evisa-documents.mjs', 'utf8');
    expect(documents.includes('strings.lookupCaptchaAsk')).toBe(true);
  });

  it('says nothing when it has everything and can just go', () => {
    // Announcing the search and then sending the picture is two messages
    // where one will do, and the first asks the applicant for nothing.
    // The picture carries its own caption.
    const strings = MESSAGES.en;
    const all = {
      applicationNumber: 'E260908XXX0000000000',
      email: 'a@example.com',
      dateOfBirth: '01/02/1990',
    };
    expect(whatToAsk(all, strings).open).toBe(true);
    expect(whatToAsk(all, strings).say).toBe(null);
  });

  it('opens the browser when the command lands, not when the details do', () => {
    // The page takes seconds to load and the applicant takes longer than
    // that to copy three things out of their email. Run together, the two
    // waits cost only the longer of them.
    const lookup = readFileSync('src/evisa-lookup.mjs', 'utf8');
    const at = lookup.indexOf('async function startLookup');
    const body = lookup.slice(at, lookup.indexOf('\n  }\n', at));
    expect(body.includes('openBrowserEarly(chatId)')).toBe(true);
    // And it does not wait on it: the reply goes out first.
    const opened = body.indexOf('openBrowserEarly(chatId)');
    const replied = body.indexOf('continueLookup');
    expect(opened < replied).toBe(true);
    expect(body.includes('await openBrowserEarly')).toBe(false);
  });

  it('stays ready for the next application after fetching one', () => {
    // Looking one up is rarely looking up only one. The chat stays in the
    // lookup, so another number starts the next without the command again;
    // what is cleared is the search the site answered.
    const documents = readFileSync('src/evisa-documents.mjs', 'utf8');
    const at = documents.indexOf('application status: ');
    const before = documents.slice(Math.max(0, at - 400), at);
    expect(before.includes('session.lookingUp = null')).toBe(true);
    expect(before.includes('session.gathering = {}')).toBe(true);
    // And it does not drop out of the lookup mode.
    expect(before.includes('MODES.idle')).toBe(false);
  });
});

describe('what the arrival declaration tells the applicant', () => {
  it('gives the window in hours, not "shortly before"', () => {
    // "Shortly before you fly" is not something anyone can act on. The site
    // takes the arrival day and the two before it, and nothing earlier.
    for (const language of ['en', 'ru']) {
      const said = MESSAGES[language].arrivalIntro;
      expect(`${language}:${said.includes('72')}`).toBe(`${language}:true`);
      expect(
        `${language}:${said.includes('prearrival.immigration.gov.vn')}`
      ).toBe(`${language}:true`);
    }
    expect(MESSAGES.ru.arrivalIntro.includes('незадолго')).toBe(false);
  });
});

describe('a document does not decide what job the chat is doing', () => {
  it('begins an application only for a chat told to do nothing else', async () => {
    // The declaration asks for a passport, the visa and the ticket by name.
    // Taking a document as proof that an application is being filled opened
    // the visa form during an arrival-card request and typed somebody's
    // passport onto it.
    const { MODES, enterMode, documentBeginsFilling } =
      await import('../src/evisa-mode.mjs');
    expect(documentBeginsFilling({})).toBe(true);
    expect(documentBeginsFilling(enterMode({}, MODES.idle))).toBe(true);
    // Told to do something else, the chat keeps that job.
    expect(documentBeginsFilling(enterMode({}, MODES.arriving))).toBe(false);
    expect(documentBeginsFilling(enterMode({}, MODES.lookingUp))).toBe(false);
  });

  it('arms no fill for a chat that is not filling', () => {
    // The window is what a fill runs at the end of. Armed for an arrival
    // card, it fills a form nobody asked for.
    const at = runner.indexOf("bot.on(['message:photo', 'message:document']");
    const body = runner.slice(at, runner.indexOf('});', at));
    expect(body.includes('documentBeginsFilling(session)')).toBe(true);
    expect(body.includes('if (fillsTheForm(session)) {')).toBe(true);
  });

  it('keeps reading the document whatever the chat is doing', () => {
    // Every job wants what the document says: the declaration needs the
    // passport as much as the form does. Only the fill is held back.
    const at = runner.indexOf("bot.on(['message:photo', 'message:document']");
    const body = runner.slice(at, runner.indexOf('});', at));
    expect(body.includes('batch.reading(')).toBe(true);
  });
});
