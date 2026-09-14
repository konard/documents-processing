import { describe, it, expect } from 'test-anywhere';
import {
  solveCaptcha,
  fillAndShow,
  ASK_AFTER_ROUNDS,
  CONFIDENT_VOTES,
} from '../src/evisa-arrival-run.mjs';
import { answerCaptcha } from '../src/evisa-prearrival-form.mjs';

/**
 * A stand-in for the site's captcha dialog.
 *
 * It answers a code the way the real one does: the right code closes the
 * dialog, and a wrong one leaves it up with a different picture in it. That
 * difference is the whole point — the bot tells the two apart by the picture,
 * since the site says nothing else.
 */
function fakeSite({ passOn = 'GOOD1' } = {}) {
  const site = {
    up: true,
    picture: 'data:image/png;base64,AAAA',
    drawn: 0,
    tried: [],
    waited: [],
    redraws: 0,
  };
  const redraw = () => {
    site.drawn += 1;
    site.picture = `data:image/png;base64,PIC${site.drawn}`;
  };
  const dialogImage = () => (site.up ? { src: site.picture } : null);

  // The driver's page functions read `document`, the way they do inside the
  // browser. Standing one up here runs the very predicates that ship, rather
  // than a test's paraphrase of them.
  globalThis.document = { querySelector: dialogImage };

  const page = {
    // Every wait the driver makes runs the predicate against the state as it
    // stands, so a test sees the same answer the browser would give.
    waitForFunction: async (fn, arg) => {
      site.waited.push(arg);
      return fn(arg);
    },
    evaluate: async (fn) => fn(),
    waitForTimeout: async () => {},
    locator: (what) => ({
      locator: () => ({ fill: async () => {} }),
      getByRole: () => ({
        click: async () => {
          const code = site.tried.at(-1);
          if (code === passOn) {
            site.up = false;
          } else {
            redraw();
          }
        },
      }),
      isVisible: async () => site.up && /CAPTCHA/.test(String(what)),
      click: async () => {},
    }),
    getByRole: () => ({
      click: async () => {
        site.redraws += 1;
        redraw();
      },
    }),
  };
  return { site, page };
}

/** OCR tools that read every picture as the code they are given. */
function readsAs(codeFor) {
  return {
    renderImage: (file) => file,
    withImageFile: async (bytes, use) => use(bytes),
    upscale: (img) => img,
    grayscale: (img) => img,
    binarize: (img) => img,
    ocrCanvas: () => codeFor(),
  };
}

describe('answering the declaration captcha', () => {
  it('does not wait out the timeout when the code is refused', async () => {
    // The site refuses by redrawing the picture in the dialog it keeps up, so
    // waiting for that dialog to go away waits the full timeout every time.
    // Six rounds of that is two minutes of a traveller watching nothing.
    const { site, page } = fakeSite({ passOn: 'RIGHT' });
    const before = site.picture;
    site.tried.push('WRONG');
    const passed = await answerCaptcha(page, 'WRONG');
    expect(passed).toBe(false);
    // The wait was told the old picture, and the new one differs from it, so
    // it ends the moment the site answers.
    expect(site.waited).toEqual([before]);
    expect(site.picture === before).toBe(false);
  });

  it('says the code passed when the dialog goes', async () => {
    const { site, page } = fakeSite({ passOn: 'RIGHT' });
    site.tried.push('RIGHT');
    expect(await answerCaptcha(page, 'RIGHT')).toBe(true);
    expect(site.up).toBe(false);
  });
});

describe('solving the declaration captcha', () => {
  const quiet = () => {};

  it('brings the chat in before it has worked through every picture', async () => {
    // A traveller watching an unsolved dialog with nothing said to them reads
    // it as a bot that has died, however hard the bot is working behind it.
    const { page } = fakeSite({ passOn: 'NEVER' });
    const asked = [];
    const ocr = readsAs(() => 'ABCD');
    await solveCaptcha({
      page,
      chatId: 1,
      log: quiet,
      ocr,
      tries: 5,
      onRound: async (round) => asked.push(round),
    });
    expect(asked[0]).toBe(1);
    expect(asked.includes(ASK_AFTER_ROUNDS)).toBe(true);
  });

  it('stops as soon as a code is taken', async () => {
    const { site, page } = fakeSite({ passOn: 'PASS1' });
    // The site takes the code on the third picture it draws.
    let seen = 0;
    const ocr = readsAs(() => {
      seen += 1;
      return seen > 36 ? 'PASS1' : 'NOPE1';
    });
    const rounds = [];
    const patched = {
      ...page,
      locator: (what) => {
        const base = page.locator(what);
        return {
          ...base,
          getByRole: () => ({
            click: async () => {
              const code = seen > 36 ? 'PASS1' : 'NOPE1';
              site.tried.push(code);
              if (code === 'PASS1') {
                site.up = false;
              } else {
                site.drawn += 1;
                site.picture = `data:image/png;base64,PIC${site.drawn}`;
              }
            },
          }),
        };
      },
    };
    const solved = await solveCaptcha({
      page: patched,
      chatId: 1,
      log: quiet,
      ocr,
      tries: 6,
      onRound: async (round) => rounds.push(round),
    });
    expect(solved).toBe(true);
    // Asked on the rounds that failed, and not once the code went through.
    expect(rounds.length < 6).toBe(true);
  });

  it('replaces a picture too unclear to be worth submitting', async () => {
    // A reading nothing agrees on is cheaper to replace than to send: a
    // refusal costs a round trip and a fresh picture costs nothing.
    const { site, page } = fakeSite({ passOn: 'NEVER' });
    let call = 0;
    const ocr = readsAs(() => {
      call += 1;
      // Eighteen readings per picture, each saying something different, so
      // nothing reaches the votes a code needs behind it.
      return `X${String(call % 90).padStart(3, '0')}`;
    });
    await solveCaptcha({
      page,
      chatId: 1,
      log: quiet,
      ocr,
      tries: 2,
      onRound: async () => {},
    });
    expect(site.redraws > 0).toBe(true);
  });

  it('needs most of the readings behind a code before it sends it', () => {
    // Measured on the live site: accepted codes carried most of the votes and
    // refused ones a handful, so the bar sits above a handful.
    expect(CONFIDENT_VOTES > 4).toBe(true);
  });
});

describe('what the chat is told after a fill', () => {
  /** A session holding an open form, and the replies it draws. */
  function filling(data) {
    const replies = [];
    const session = {
      language: 'en',
      data,
      arrival: { stage: 'form', page: {}, browser: {} },
      uploads: {},
    };
    return {
      replies,
      sessions: { get: () => session },
      ctx: { reply: async (text) => replies.push(text) },
    };
  }

  const MESSAGES = {
    en: {
      arrivalNothingToFill: 'tell me your nationality',
      arrivalFilled: 'on the form',
    },
  };

  it('adds nothing to the message /arrival has already sent', async () => {
    // The values and what is still wanted went out a moment ago. Saying the
    // same values are now on a page the traveller cannot see is the same
    // information a second time.
    const { replies, sessions, ctx } = filling({});
    const out = await fillAndShow({
      ctx,
      chatId: 1,
      sessions,
      log: () => {},
      MESSAGES,
      describeFilled: () => 'what went in',
      quiet: true,
    });
    expect(out.waiting).toBe(true);
    expect(replies).toEqual([]);
  });

  it('answers what the traveller just sent', async () => {
    const { replies, sessions, ctx } = filling({});
    await fillAndShow({
      ctx,
      chatId: 1,
      sessions,
      log: () => {},
      MESSAGES,
      describeFilled: () => 'what went in',
    });
    expect(replies).toEqual(['tell me your nationality']);
  });
});
