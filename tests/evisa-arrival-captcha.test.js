import { describe, it, expect } from 'test-anywhere';
import {
  solveCaptcha,
  fillAndShow,
  ASK_AFTER_ROUNDS,
  CAPTCHA_TRIES,
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
function fakeSite({ passOn = 'GOOD1', servesNothing = 0 } = {}) {
  const site = {
    up: true,
    picture: 'data:image/png;base64,AAAA',
    drawn: 0,
    tried: [],
    waited: [],
    redraws: 0,
    // How many more times the captcha service answers with nothing, as it
    // does when its own page reads "CAPTCHA is unavailable".
    broken: servesNothing,
  };
  if (site.broken) {
    site.picture = '';
  }
  // A reload while the service is down answers with nothing; the one that
  // finds it recovered answers with a picture, the way the real site does.
  const redraw = () => {
    site.drawn += 1;
    if (site.broken > 0) {
      site.broken -= 1;
      site.picture = site.broken > 0 ? '' : `data:image/png;base64,BACK`;
      return;
    }
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
      // What the driver types into the box. Verify judges that, which is how
      // the real site decides, so a test arranges nothing beforehand.
      locator: () => ({
        fill: async (code) => site.tried.push(code),
      }),
      getByRole: () => ({
        click: async () => {
          if (site.tried.at(-1) === passOn) {
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
    const passed = await answerCaptcha(page, 'WRONG');
    expect(passed).toBe(false);
    // The wait was told the old picture, and the new one differs from it, so
    // it ends the moment the site answers.
    expect(site.waited).toEqual([before]);
    expect(site.picture === before).toBe(false);
  });

  it('says the code passed when the dialog goes', async () => {
    const { site, page } = fakeSite({ passOn: 'RIGHT' });
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
      onRound: async (round) => {
        asked.push(round);
        return false;
      },
    });
    expect(asked[0]).toBe(1);
    expect(asked.includes(ASK_AFTER_ROUNDS)).toBe(true);
  });

  it('leaves the picture alone after the chat has been sent it', async () => {
    // The whole point of handing it over. Reading on draws a new picture, and
    // the code the traveller carefully read off the one they were sent is
    // then answered against a picture that is no longer on the page — so
    // every code they send is refused, however well they read it.
    const { site, page } = fakeSite({ passOn: 'NEVER' });
    const ocr = readsAs(() => 'ABCD');
    // The picture as it stood at the moment the chat was sent it, which is
    // the one the traveller is reading their code off.
    let handedOver = null;
    const solved = await solveCaptcha({
      page,
      chatId: 1,
      log: quiet,
      ocr,
      tries: 6,
      onRound: async (round) => {
        if (round < ASK_AFTER_ROUNDS) {
          return false;
        }
        handedOver = site.picture;
        // What askCaptcha reports when the picture reached the chat.
        return true;
      },
    });
    expect(solved).toBe(false);
    expect(handedOver).not.toBe(null);
    // Still on the page, untouched, waiting for the code that was read off it.
    expect(site.picture).toBe(handedOver);
    expect(site.up).toBe(true);
    // And the code the traveller sends is answered against that same picture.
    expect(await answerCaptcha(page, 'THEIR')).toBe(false);
    expect(site.tried.at(-1)).toBe('THEIR');
  });

  it('stops as soon as a code is taken', async () => {
    // A picture the bot reads confidently is submitted, and the one the site
    // accepts ends the loop with the dialog gone.
    const { site, page } = fakeSite({ passOn: 'GOODC' });
    const rounds = [];
    const solved = await solveCaptcha({
      page,
      chatId: 1,
      log: quiet,
      ocr: readsAs(() => 'GOODC'),
      tries: 6,
      onRound: async (round) => {
        rounds.push(round);
        return false;
      },
    });
    expect(solved).toBe(true);
    expect(site.up).toBe(false);
    // Taken on the first picture, so nobody was ever asked.
    expect(rounds).toEqual([]);
  });

  it('submits nothing when its reading is one it does not trust', async () => {
    // A wrong answer counts against the sender whoever sent it, and this is a
    // government immigration site. A reading with a handful of votes behind
    // it is usually wrong, so it is not sent at all: the picture goes
    // untouched to the person, who reads these better anyway.
    const { site, page } = fakeSite({ passOn: 'NEVER' });
    let call = 0;
    const ocr = readsAs(() => {
      call += 1;
      // Eighteen readings of the picture, each saying something different, so
      // nothing reaches the votes a code needs behind it.
      return `X${String(call % 90).padStart(3, '0')}`;
    });
    const before = site.picture;
    await solveCaptcha({
      page,
      chatId: 1,
      log: quiet,
      ocr,
      onRound: async () => true,
    });
    // Nothing typed, nothing verified, and the picture still the one read.
    expect(site.tried).toEqual([]);
    expect(site.drawn).toBe(0);
    expect(site.picture).toBe(before);
  });

  it('has exactly one go at it before the person is asked', async () => {
    // Six pictures a minute against a government site's captcha looks like
    // something being attacked, and being blocked costs a traveller the
    // filing altogether.
    const { site, page } = fakeSite({ passOn: 'NEVER' });
    const rounds = [];
    await solveCaptcha({
      page,
      chatId: 1,
      log: quiet,
      ocr: readsAs(() => 'ABCDE'),
      onRound: async (round) => {
        rounds.push(round);
        return true;
      },
    });
    expect(CAPTCHA_TRIES).toBe(1);
    expect(ASK_AFTER_ROUNDS).toBe(1);
    // One submission, and the chat asked on that very round.
    expect(site.tried).toEqual(['ABCDE']);
    expect(rounds).toEqual([1]);
  });

  it("waits out a brief outage of the site's own captcha service", async () => {
    // Its page reads "CAPTCHA is unavailable" over an empty box and recovers
    // within seconds. Giving up on the first empty answer would end a
    // declaration over a hiccup nobody needs to hear about.
    const { site, page } = fakeSite({ passOn: 'GOODC', servesNothing: 1 });
    let stalled = false;
    const solved = await solveCaptcha({
      page,
      chatId: 1,
      log: quiet,
      ocr: readsAs(() => 'GOODC'),
      tries: 6,
      onRound: async () => false,
      onStalled: () => {
        stalled = true;
      },
    });
    expect(solved).toBe(true);
    expect(stalled).toBe(false);
    expect(site.up).toBe(false);
  });

  it('says so when the site keeps issuing no picture at all', async () => {
    // Nothing to read and nothing to send. A page showing the site's own
    // error with no word from the bot looks like the bot is what broke.
    const { page } = fakeSite({ passOn: 'GOODC', servesNothing: 99 });
    let stalled = false;
    const asked = [];
    const solved = await solveCaptcha({
      page,
      chatId: 1,
      log: quiet,
      ocr: readsAs(() => 'GOODC'),
      tries: 4,
      onRound: async (round) => {
        asked.push(round);
        return false;
      },
      onStalled: () => {
        stalled = true;
      },
    });
    expect(solved).toBe(false);
    expect(stalled).toBe(true);
    // Never asked to read a picture, because there was never one to send.
    expect(asked).toEqual([]);
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
