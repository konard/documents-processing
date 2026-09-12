import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';
import { isCommand } from '../src/evisa-lookup.mjs';
import {
  MODES,
  enterMode,
  fillsTheForm,
  captchaIsForLookup,
} from '../src/evisa-mode.mjs';

const runner = readFileSync('src/evisa-bot-run.mjs', 'utf8');

/** A message as Telegram sends it, with the command marked at the start. */
const commandMessage = (text) => ({
  text,
  entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0] }],
});

describe('a command is not a detail for the form', () => {
  it('knows a command by the entity Telegram marks it with', () => {
    expect(
      isCommand(commandMessage('/download_visa E260908XXX0000000000'))
    ).toBe(true);
    expect(isCommand(commandMessage('/start'))).toBe(true);
  });

  it('does not take a mention of a command for one', () => {
    // Someone writing about a command is not running it.
    expect(isCommand({ text: 'use /download_visa for that' })).toBe(false);
    expect(isCommand({ text: 'TRAVELLER JOHN' })).toBe(false);
    expect(isCommand({})).toBe(false);
  });

  it('never takes a command as one where it is not at the start', () => {
    expect(
      isCommand({
        text: 'ask me /download_visa',
        entities: [{ type: 'bot_command', offset: 8, length: 14 }],
      })
    ).toBe(false);
  });

  it('does not arm a fill when the message was a command', () => {
    // The text handler sees commands too. Arming there meant /download_visa
    // asked the bot to fill in a visa application: a browser opened on the
    // form, filled it with defaults, and photographed it section by section.
    const at = runner.indexOf("bot.on('message:text'");
    const body = runner.slice(at, runner.indexOf('\n});', at));
    expect(body.includes('isCommand(ctx.message)')).toBe(true);
    expect(body.includes('fillsTheForm(session)')).toBe(true);
  });

  it('does not read a command´s own words as details', () => {
    // "/download_visa E2609..." parsed as free text puts the number and
    // anything beside it on the application form.
    const at = runner.indexOf('async function receiveText');
    const body = runner.slice(at, runner.indexOf('\n}\n', at));
    const guard = body.indexOf('isCommand(ctx.message)');
    const parse = body.indexOf('parseFreeText');
    expect(guard > -1).toBe(true);
    // The guard has to come first, or the parse has happened anyway.
    expect(guard < parse).toBe(true);
  });
});

describe('a lookup opens no application', () => {
  it('opens the browser with no page loaded for a lookup', () => {
    // A lookup needs a browser, not a form. Opening the form for one left an
    // empty application in the chat's page, and it was photographed.
    const documents = readFileSync('src/evisa-documents.mjs', 'utf8');
    expect(documents.includes('pageFor(chatId, { blank: !held })')).toBe(true);
  });

  it('loads the form later, when something actually wants one', () => {
    // The blank page is the chat's page: a fill that follows a lookup has to
    // find an application on it.
    expect(runner.includes('held.blank && !blank')).toBe(true);
    expect(runner.includes('await loadForm(held.page)')).toBe(true);
  });
});

describe('reading the captcha off a page', () => {
  it('waits for the picture, not just the element holding it', async () => {
    // The site puts the img on the page with a placeholder src and swaps in
    // the data URL about half a second later. Waiting for the element alone
    // read the placeholder and reported no captcha, which only stayed hidden
    // while something slow ran first.
    const { chromium } = await import('playwright');
    const { readCaptcha } = await import('../src/evisa-fill.mjs');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(
      '<img alt="captcha img" src="https://example.com/placeholder">'
    );
    // The swap the site makes, after the element is already there.
    /* global document */
    page.evaluate(() => {
      setTimeout(() => {
        document.querySelector('img[alt="captcha img"]').src =
          'data:image/png;base64,aGVsbG8=';
      }, 300);
    });
    const read = await readCaptcha(page);
    await browser.close();
    expect(read === null).toBe(false);
    expect(read.toString()).toBe('hello');
  });
});

describe('a lookup never fills in a form', () => {
  it('fills only for a chat whose job is filling', () => {
    // /download_visa fetches a filed application. Every step of it — the
    // command, the details it asks for, the captcha code — is text, and
    // arming on text meant each one queued a fill of a blank visa form.
    // Which job the chat is doing is what settles it, not the message.
    expect(fillsTheForm(enterMode({}, MODES.filling))).toBe(true);
    expect(fillsTheForm(enterMode({}, MODES.lookingUp))).toBe(false);
    expect(fillsTheForm(enterMode({}, MODES.arriving))).toBe(false);
    // A chat that has done nothing has begun no application either.
    expect(fillsTheForm({})).toBe(false);
    expect(fillsTheForm(enterMode({}, MODES.idle))).toBe(false);
  });

  it('reads a captcha code as the lookup´s only while one is waiting', () => {
    // Both the form and the search ask for a code, and six digits look the
    // same either way.
    const waiting = enterMode({}, MODES.lookingUp);
    waiting.lookingUp = 'E2609';
    expect(captchaIsForLookup(waiting)).toBe(true);
    // The mode alone is not enough: no search is open yet while the details
    // it needs are still being gathered.
    expect(captchaIsForLookup(enterMode({}, MODES.lookingUp))).toBe(false);
    // And a code sent while filling belongs to the form.
    const filling = enterMode({ lookingUp: 'E2609' }, MODES.filling);
    expect(captchaIsForLookup(filling)).toBe(false);
  });

  it('drops what a lookup was holding when the chat moves on', () => {
    // A half-gathered lookup left behind would claim the next message sent.
    const moved = enterMode(
      { lookingUp: 'E2609', gathering: { email: 'a@example.com' } },
      MODES.filling
    );
    expect(moved.lookingUp).toBe(null);
    expect(moved.gathering).toBe(null);
  });

  it('names every job the bot does', () => {
    // A mode that is set but never read is a job nothing can tell apart.
    expect(Object.keys(MODES).sort()).toEqual([
      'arriving',
      'filling',
      'idle',
      'lookingUp',
    ]);
    for (const [name, mode] of Object.entries(MODES)) {
      expect(mode).toBe(name);
    }
  });

  it('says which job every entry point puts the chat into', () => {
    // The whole point of the split: each command names its own mode, so
    // nothing has to be inferred from whichever flags happen to be set.
    const commands = readFileSync('src/evisa-commands.mjs', 'utf8');
    const lookup = readFileSync('src/evisa-lookup.mjs', 'utf8');
    // The arrival card is filed on its own site; its command lives with the
    // declaration it draws.
    const prearrival = readFileSync('src/evisa-prearrival.mjs', 'utf8');
    expect(lookup.includes('MODES.lookingUp')).toBe(true);
    expect(commands.includes('MODES.filling')).toBe(true);
    expect(prearrival.includes('MODES.arriving')).toBe(true);
    expect(runner.includes('MODES.idle')).toBe(true);
  });
});
