import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';
import { sectionName } from '../src/evisa-bot.mjs';
import * as sectionsModule from '../src/evisa-sections.mjs';

const session = readFileSync('src/evisa-session.mjs', 'utf8');

// The headings exactly as the live form prints them, taken off the page: the
// images heading in sentence case, and section eight with a typographic
// apostrophe. Both were written differently in the table that translates them,
// and both fell through to English in a Russian conversation.
const AS_THE_SITE_PRINTS_THEM = [
  "FOREIGNER'S IMAGES",
  '1. PERSONAL INFORMATION',
  '2. REQUESTED INFORMATION',
  '3. PASSPORT INFORMATION',
  '4. CONTACT INFORMATION',
  '5. OCCUPATION',
  '6. INFORMATION ABOUT THE TRIP',
  '7. ACCOMPANY CHILD(REN) UNDER 14 YEARS OLD WHO ARE ISSUED WITH THE SAME PASSPORT',
  '8. TRIP’S EXPENSES, INSURANCE',
];

describe('a part of the form is named in the applicant´s language', () => {
  it('names every heading the live form prints', () => {
    for (const title of AS_THE_SITE_PRINTS_THEM) {
      const named = sectionName(title, 'ru');
      expect(`${title.slice(0, 14)}:${/[а-яА-Я]/.test(named)}`).toBe(
        `${title.slice(0, 14)}:true`
      );
    }
  });

  it('reads both apostrophes as the same apostrophe', () => {
    // The site types U+2019 and a keyboard types U+0027.
    expect(sectionName('8. TRIP’S EXPENSES, INSURANCE', 'ru')).toBe(
      sectionName("8. TRIP'S EXPENSES, INSURANCE", 'ru')
    );
  });

  it('names the images heading however it is capitalised', () => {
    // The page prints "Foreigner's images"; the table held it shouted.
    expect(sectionName("Foreigner's images", 'ru')).toBe(
      sectionName("FOREIGNER'S IMAGES", 'ru')
    );
  });

  it('leaves a heading alone in a language it has no names for', () => {
    expect(sectionName('5. OCCUPATION', 'en')).toBe('5. OCCUPATION');
  });
});

describe('a part is captured as itself', () => {
  it('takes the site´s own bars off the page, and does not merely move them', () => {
    // A sticky bar that is only made static keeps its place in the flow and
    // is still drawn, which puts the navigation inside whichever part is
    // being cut. Both bars are hidden outright.
    expect(session.includes('.navbar, .step-custom')).toBe(true);
    expect(session.includes('display: none !important')).toBe(true);
    expect(session.includes('position: static !important')).toBe(false);
  });

  it('lets the page lay itself out again before measuring it', () => {
    // Hiding the bars shortens everything above the part being measured, so
    // a measurement taken in the same breath belongs to the page as it was.
    const held = session.slice(session.indexOf('async function holdStill'));
    const body = held.slice(0, held.indexOf('\n}\n'));
    expect(body.includes('requestAnimationFrame')).toBe(true);
  });

  it('settles every part before capturing it, filled or not', () => {
    // A part with nothing to fill is not already still: the part above it was
    // just typed into, and the form is still re-laying itself out underneath.
    const fill = session.slice(
      session.indexOf('export async function fillBySection')
    );
    const body = fill.slice(0, fill.indexOf('\n}\n'));
    const settle = body.indexOf('await settleForm(page, { timeout: 8000 })');
    const report = body.indexOf('await report(at, title');
    expect(settle > 0 && report > settle).toBe(true);
  });

  it('lets go of the last field before waiting for the form to check it', () => {
    // The form checks a field when it is left. Captured with the field still
    // held, it showed a red border against a value the site accepted.
    const settle = session.slice(
      session.indexOf('export async function settleForm')
    );
    const body = settle.slice(0, settle.indexOf('\n}\n'));
    const blur = body.indexOf('blur');
    const validating = body.indexOf('ant-form-item-is-validating');
    expect(blur > 0 && validating > blur).toBe(true);
  });

  it('waits only for the pictures the page is showing', () => {
    // The form carries two hidden images with no source of their own. They
    // count as loaded and will never have a width, so a wait on every image
    // runs to its timeout on a page with nothing left to draw: eight and a
    // half seconds for each part, seventy-seven for the form. A picture the
    // applicant can see is still waited for.
    const settle = session.slice(
      session.indexOf('export async function settleForm')
    );
    const body = settle.slice(0, settle.indexOf('\n}\n'));
    const images = body.slice(body.indexOf('document.images'));
    const guarded = images.slice(0, images.indexOf('.every('));
    expect(guarded.includes('offsetParent !== null')).toBe(true);
    expect(guarded.includes('getBoundingClientRect().width > 0')).toBe(true);
    // And what it waits for is still that they have actually drawn.
    expect(images.includes('image.complete && image.naturalWidth > 0')).toBe(
      true
    );
  });

  it('ticks the declarations before any part is shown', () => {
    // Two of them sit inside the parts about the trip and its expenses, so
    // ticking them after the walk meant those parts were photographed with
    // their boxes still empty: a picture of a form that was not the form.
    const fill = session.slice(
      session.indexOf('export async function fillBySection')
    );
    const body = fill.slice(0, fill.indexOf('\n}\n'));
    const ticked = body.indexOf('result.declared = await tickDeclarations');
    const walk = body.indexOf('for (const { at, title } of shown)');
    expect(ticked > 0 && ticked < walk).toBe(true);
  });

  it('shows each part once, the pictures included', () => {
    // The pictures are uploaded before the parts are walked, and the part
    // they sit in has no number of its own, so it is numbered by its place:
    // zero, the same as the uploads. Reporting it in both places sent the
    // applicant the same picture twice. Only the walk reports.
    const fill = session.slice(
      session.indexOf('export async function fillBySection')
    );
    const body = fill.slice(0, fill.indexOf('\n}\n'));
    const uploading = body.slice(
      body.indexOf('if (uploads'),
      body.indexOf('const filling =')
    );
    expect(uploading.includes('report(')).toBe(false);
    // And the walk still reports every part it finds.
    const walk = body.slice(body.indexOf('for (const { at, title } of shown)'));
    expect(walk.includes('await report(at, title')).toBe(true);
  });

  it('ends the last part under the buttons, not under the footer', () => {
    // The footer is the site´s address and hotline: none of it is the
    // applicant´s to check.
    const capture = session.slice(
      session.indexOf('export async function captureSection')
    );
    const body = capture.slice(0, capture.indexOf('\n}\n'));
    expect(body.includes('footer')).toBe(true);
    expect(body.includes("querySelectorAll('button')")).toBe(true);
  });
});

describe('what the chat is sent', () => {
  const sections = readFileSync('src/evisa-sections.mjs', 'utf8');

  it('puts a part´s name above its picture, in one message', () => {
    // The API draws a caption under a photo unless it is told otherwise, and
    // the applicant needs to know what they are looking at before they look.
    const send = sections.slice(
      sections.indexOf('export async function sendSection')
    );
    const body = send.slice(0, send.indexOf('\n}\n'));
    expect(body.includes('show_caption_above_media: true')).toBe(true);
    // One message: the name is the picture's caption, not a message before it.
    expect(body.includes('ctx.reply(')).toBe(false);
  });

  it('says everything in one message, where the limit is four times larger', () => {
    const { splitForMessage } = sectionsModule;
    // A caption holds a thousand characters; a message holds four thousand,
    // which a whole form is well inside.
    expect(splitForMessage('one\n\ntwo')).toEqual(['one\n\ntwo']);
    expect(splitForMessage('x'.repeat(4000)).length).toBe(1);
  });

  it('cuts at a blank line when even a message will not hold it', () => {
    const { splitForMessage } = sectionsModule;
    const long = ['a'.repeat(3000), 'b'.repeat(3000)].join('\n\n');
    const parts = splitForMessage(long);
    expect(parts.length).toBe(2);
    // Neither block is split down the middle.
    expect(parts[0]).toBe('a'.repeat(3000));
    expect(parts[1]).toBe('b'.repeat(3000));
  });

  it('counts the text the way Telegram counts it, without the markup', () => {
    // The limit is on the text as shown; tags are free. Counting them would
    // split what would have fitted.
    const { splitForMessage } = sectionsModule;
    expect(splitForMessage(`<b>${'x'.repeat(4000)}</b>`).length).toBe(1);
  });

  it('sends the page with no caption, named in the applicant´s language', () => {
    // The file's name is drawn above it by the client and says what it is,
    // so a caption under it would only repeat the first thousand characters
    // of what the message after it says in full.
    const send = sections.slice(
      sections.indexOf('export async function sendOutcome')
    );
    const body = send.slice(0, send.indexOf('\n}\n'));
    expect(body.includes('new InputFile(result.screenshot, fileName)')).toBe(
      true
    );
    expect(body.includes('caption:')).toBe(false);
  });
});

describe('a page with a dialog over it', () => {
  it('is not cut into parts, since the dialog covers them', () => {
    // The registration dialog opens over the review page. Cutting that page
    // into its parts then gives a white box with a corner of the dialog in
    // it, and the parts under it are ones the applicant has already seen.
    const runner = readFileSync('src/evisa-bot-run.mjs', 'utf8');
    const press = runner.slice(runner.indexOf('function pressNextAndShow'));
    const body = press.slice(0, press.indexOf('\n}\n'));
    const guard = body.indexOf('if (!step.dialog)');
    const parts = body.indexOf('await showPageInParts(');
    expect(guard > 0 && guard < parts).toBe(true);
  });
});

describe('how a page reaches the chat', () => {
  const runner = readFileSync('src/evisa-bot-run.mjs', 'utf8');

  it('sends a dialog as a picture, and a whole page as a file', () => {
    // A dialog is one screen: drawn in place, the applicant reads it where
    // it lands. A whole page is nine screens and a chat shrinks a picture
    // to fit, so that one stays a file and keeps its detail.
    const press = runner.slice(runner.indexOf('function pressNextAndShow'));
    const body = press.slice(0, press.indexOf('\n}\n'));
    expect(body.includes('step.dialog\n        ? ctx.replyWithPhoto')).toBe(
      true
    );
    expect(body.includes(': ctx.replyWithDocument(')).toBe(true);
  });
});
