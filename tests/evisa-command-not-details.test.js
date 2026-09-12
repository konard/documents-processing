import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';
import { isCommand } from '../src/evisa-lookup.mjs';

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
    const body = runner.slice(at, runner.indexOf('});', at));
    expect(body.includes('!isCommand(ctx.message)')).toBe(true);
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
