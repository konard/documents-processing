import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  walkTheDeclaration,
  fileTheDeclaration,
  whichStep,
  turnTo,
  returnToPassenger,
  STEPS,
} from '../src/evisa-prearrival-pages.mjs';
import {
  fillTrip,
  provinceAsNamedHere,
  readTrip,
  wardAsNamedHere,
  purposeAsNamedHere,
  stayAsNamedHere,
  TRIP_FIELDS,
  FLIGHT_LIST_MS,
} from '../src/evisa-prearrival-trip.mjs';

/**
 * A stand-in for the site's four-step form.
 *
 * It behaves the way the live one does about the only thing that matters
 * here: a page it will not accept leaves the step marker where it was, and
 * prints its complaint under the fields holding it up. Nothing else says
 * whether a page turned.
 */
function fakeSite({ blocks = {}, at = 0, captchaOn = [] } = {}) {
  const site = { at, pressed: [], ticked: false, filed: false, captcha: false };
  const refusals = () => blocks[site.at] ?? [];
  globalThis.document = {
    querySelector: (what) =>
      /role=dialog/.test(what) && site.captcha
        ? { innerText: 'CAPTCHA Verification' }
        : null,
    querySelectorAll: (what) => {
      if (/MuiStep-root/.test(what)) {
        return STEPS.map((title, index) => ({
          innerText: index === site.at ? `${index + 1}\n${title}` : title,
          querySelector: () => (index === site.at ? {} : null),
        }));
      }
      // The complaints the site prints under a blocked field.
      return refusals().map((words) => ({
        innerText: words,
        parentElement: null,
      }));
    },
  };
  const page = {
    evaluate: async (fn) => fn(),
    waitForFunction: async (fn, arg) => fn(arg),
    waitForTimeout: async () => {},
    locator: (what) => ({
      isVisible: async () => /role=dialog/.test(String(what)) && site.captcha,
    }),
    getByRole: (role, options) => ({
      first: () => ({
        click: async () => {
          // The caller asks for a button by a pattern, so the button pressed
          // is whichever the page has that the pattern names.
          const wanted = options?.name ?? '';
          const hit = STEPS.find((title) =>
            wanted instanceof RegExp ? wanted.test(title) : title === wanted
          );
          const isSubmit =
            wanted instanceof RegExp
              ? wanted.test('Submit')
              : /Submit/.test(wanted);
          site.pressed.push(hit ?? (isSubmit ? 'Submit' : String(wanted)));
          const action = hit ?? (isSubmit ? 'Submit' : String(wanted));
          if (captchaOn.includes(action)) {
            site.captcha = true;
            return;
          }
          if (!hit && isSubmit) {
            site.filed = true;
            site.at = 3;
            return;
          }
          // The site turns the page only when nothing is holding it up.
          if (hit && !refusals().length) {
            site.at = STEPS.indexOf(hit);
          }
        },
        check: async () => {
          site.ticked = true;
        },
      }),
    }),
    getByText: () => ({
      first: () => ({
        click: async () => {
          site.ticked = true;
        },
      }),
    }),
  };
  return { site, page };
}

/** A page's fill, as the walk reports one. */
const done = (filled = []) => ({ filled, missing: [], failed: [] });

describe('walking the declaration to its review', () => {
  it('fills every page and stops on the review', async () => {
    const { site, page } = fakeSite();
    const shown = [];
    const out = await walkTheDeclaration({
      page,
      fillPassenger: async () => done(['passportNumber']),
      fillTrip: async () => done(['vehicleNumber']),
      onPage: async ({ at, title }) => {
        shown.push(`${at}:${title}`);
      },
    });
    expect(out.reached).toBe(2);
    expect(out.stopped).toBe(null);
    // Every page is shown as it is finished, the review among them.
    expect(shown).toEqual([
      '0:Passenger Information',
      '1:Trip Information',
      '2:Review & Submit',
    ]);
    // The walk presses only the two buttons that turn a page.
    expect(site.pressed).toEqual(['Trip Information', 'Review & Submit']);
  });

  it('names the passport upload and every other field in the log', async () => {
    // A count of eighteen cannot prove which eighteenth action happened.
    // Naming the fields lets the retained trace distinguish an uploaded
    // passport from any other successful input without logging its value.
    const { page } = fakeSite();
    const lines = [];
    await walkTheDeclaration({
      page,
      fillPassenger: async () => ({
        filled: ['passportNumber', 'passportImage', 'visaNumber'],
        missing: [],
        failed: [],
      }),
      fillTrip: async () => ({
        filled: ['province', 'ward'],
        missing: [],
        failed: ['vehicleNumber: SECRET_SENTINEL'],
      }),
      log: (line) => lines.push(line),
    });
    expect(lines[0].includes('passportImage')).toBe(true);
    expect(lines[0].includes('passportNumber')).toBe(true);
    expect(lines.some((line) => line.includes('failed [vehicleNumber]'))).toBe(
      true
    );
    expect(lines.some((line) => line.includes('SECRET_SENTINEL'))).toBe(false);
    expect(lines.some((line) => line.includes('province, ward'))).toBe(true);
  });

  it('files nothing on its way through', async () => {
    // The walk reaches the page the Submit button is on. A walk that pressed
    // it would file a declaration nobody had read.
    const { site, page } = fakeSite();
    await walkTheDeclaration({
      page,
      fillPassenger: async () => done(),
      fillTrip: async () => done(),
    });
    expect(site.filed).toBe(false);
    expect(site.ticked).toBe(false);
    // "Review & Submit" is the name of a step and pressing it turns a page.
    // The button that files is called "Submit" and nothing pressed it.
    expect(site.pressed.includes('Submit')).toBe(false);
  });

  it('stops where the site will not let it through, and says why', async () => {
    // The site names the fields holding the page up. Those are what the
    // traveller has to supply, so they are what they are told about.
    const { page } = fakeSite({
      blocks: { 1: ['Border Gate: Please fill in the field above'] },
    });
    const shown = [];
    const out = await walkTheDeclaration({
      page,
      fillPassenger: async () => done(),
      fillTrip: async () => done(),
      onPage: async ({ at }) => shown.push(at),
    });
    expect(out.reached).toBe(1);
    expect(out.stopped).toBe('Trip Information');
    expect(out.refused).toEqual([
      'Border Gate: Please fill in the field above',
    ]);
    // The page it stopped on was still shown: the traveller is looking at
    // the page they have to put right.
    expect(shown).toEqual([0, 1]);
  });

  it('goes no further when the first page is one the site refuses', async () => {
    const { page } = fakeSite({ blocks: { 0: ['Visa Number: required'] } });
    const out = await walkTheDeclaration({
      page,
      fillPassenger: async () => done(),
      fillTrip: async () => {
        throw new Error('the trip page must not be filled');
      },
    });
    expect(out.reached).toBe(0);
    expect(out.stopped).toBe('Passenger Information');
  });

  it('does not let a permissive Next button hide missing trip facts', async () => {
    // The live site may advance with required stay details blank.
    // Reaching Review therefore cannot be used as evidence that the record is
    // complete: the bot has to keep the traveller on the page that needs them.
    const { site, page } = fakeSite();
    const out = await walkTheDeclaration({
      page,
      fillPassenger: async () => done(),
      fillTrip: async () => ({
        filled: ['vehicleNumber'],
        missing: ['province', 'accommodationAddress'],
        failed: [],
      }),
    });
    expect(out.reached).toBe(1);
    expect(out.stopped).toBe('Trip Information');
    expect(site.pressed).toEqual(['Trip Information']);
  });

  it('does not block on the optional passport-image second opinion', async () => {
    const { site, page } = fakeSite();
    const out = await walkTheDeclaration({
      page,
      fillPassenger: async () => ({
        filled: ['passportNumber'],
        missing: [],
        failed: ['passportImage: the site read nothing from it'],
      }),
      fillTrip: async () => done(),
    });
    expect(out.reached).toBe(2);
    expect(site.pressed).toEqual(['Trip Information', 'Review & Submit']);
  });

  it('returns a corrected declaration to the passenger page before refilling', async () => {
    const { site, page } = fakeSite({ at: 1 });
    const returned = await returnToPassenger(page);
    expect(returned).toBe(true);
    expect(site.at).toBe(0);
    expect(site.pressed).toEqual(['Passenger Information']);
  });

  it('stops on a date the site will not take, without turning a page', async () => {
    const { site, page } = fakeSite();
    const out = await walkTheDeclaration({
      page,
      fillPassenger: async () => ({ ...done(), arrival: { tooEarly: true } }),
      fillTrip: async () => {
        throw new Error('nothing should be filled past a refused date');
      },
    });
    expect(out.reached).toBe(0);
    expect(site.pressed).toEqual([]);
  });
});

describe('a failed passport upload', () => {
  it('is required before the walk continues', async () => {
    const { site, page } = fakeSite();
    const out = await walkTheDeclaration({
      page,
      fillPassenger: async () => ({
        filled: ['passportNumber'],
        missing: [],
        failed: ['passportImage: file chooser rejected the upload'],
      }),
      fillTrip: async () => {
        throw new Error('the trip page must not be filled');
      },
    });
    expect(out.reached).toBe(0);
    expect(site.pressed).toEqual([]);
  });
});

describe('filing the declaration', () => {
  it('files nothing without the traveller saying so', async () => {
    // The whole guard. This is the only path in the bot that sends anything
    // to an immigration department, and an unconfirmed call must do nothing
    // at all: not tick the box, not press the button.
    const { site, page } = fakeSite({ at: 2 });
    const out = await fileTheDeclaration(page, {});
    expect(out.filed).toBe(false);
    expect(out.why).toBe('not confirmed');
    expect(site.ticked).toBe(false);
    expect(site.pressed).toEqual([]);
    expect(site.filed).toBe(false);
  });

  it('treats anything but a plain true as no', async () => {
    // A confirmation that arrives as a string, a number or an object is not
    // one the traveller gave; it is something that slipped through a check.
    for (const said of ['yes', 1, {}, [], 'true', null, undefined]) {
      const { site, page } = fakeSite({ at: 2 });
      const out = await fileTheDeclaration(page, { confirmed: said });
      expect(out.filed).toBe(false);
      expect(site.filed).toBe(false);
    }
  });

  it('files nothing from a page that is not the review', async () => {
    // Confirmed or not, there is nothing to file from the middle of the form,
    // and a Submit pressed there would be pressed on the wrong page.
    const { site, page } = fakeSite({ at: 1 });
    const out = await fileTheDeclaration(page, { confirmed: true });
    expect(out.filed).toBe(false);
    expect(out.why).toBe('not on the review page');
    expect(site.pressed).toEqual([]);
  });

  it('ticks the box and presses Submit on the traveller´s word', async () => {
    const { site, page } = fakeSite({ at: 2 });
    const out = await fileTheDeclaration(page, { confirmed: true });
    expect(out.filed).toBe(true);
    expect(site.ticked).toBe(true);
    expect(site.pressed.some((one) => /Submit/.test(one))).toBe(true);
  });

  it('reports a CAPTCHA gate without claiming the declaration failed', async () => {
    const { site, page } = fakeSite({ at: 2, captchaOn: ['Submit'] });
    const out = await fileTheDeclaration(page, { confirmed: true });
    expect(out.captcha).toBe(true);
    expect(out.filed).toBe(false);
    expect(out.refused).toEqual([]);
    expect(site.filed).toBe(false);
  });
});

describe('reading where the form has got to', () => {
  it('reads the step off the page, the URL saying nothing', async () => {
    const { page } = fakeSite({ at: 1 });
    expect((await whichStep(page)).at).toBe(1);
  });

  it('calls a page that did not move a page that did not turn', async () => {
    const { page } = fakeSite({ blocks: { 0: ['something'] } });
    const turned = await turnTo(page, 'Trip Information');
    expect(turned.turned).toBe(false);
    expect(turned.refused).toEqual(['something']);
  });

  it('recognizes a CAPTCHA before returning or photographing the old page', async () => {
    const { site, page } = fakeSite({ captchaOn: ['Trip Information'] });
    const turned = await turnTo(page, 'Trip Information');
    expect(turned).toEqual({
      turned: false,
      at: 0,
      refused: [],
      captcha: true,
    });
    expect(site.at).toBe(0);
  });

  it('detects the transition CAPTCHA in a real Playwright page', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <div class="MuiStep-root"><span class="Mui-active"></span>Passenger Information</div>
        <div class="MuiStep-root">Trip Information</div>
        <button id="next">Trip Information</button>
        <script>
          document.querySelector('#next').addEventListener('click', () => {
            const dialog = document.createElement('div');
            dialog.setAttribute('role', 'dialog');
            dialog.textContent = 'CAPTCHA Verification';
            document.body.append(dialog);
          });
        </script>
      `);

      expect(await turnTo(page, 'Trip Information')).toEqual({
        turned: false,
        at: 0,
        refused: [],
        captcha: true,
      });
    } finally {
      await browser.close();
    }
  });
});

describe('what the trip page is told to say', () => {
  it('calls a tourist trip what the site calls it', () => {
    // The e-visa says "Tourist" and this page offers "Travel", so the value
    // that filled the visa matches no option here.
    expect(purposeAsNamedHere('Tourist')).toBe('Travel');
    expect(purposeAsNamedHere('tourism')).toBe('Travel');
    expect(purposeAsNamedHere('Business')).toBe('Business trip');
    // Already the site's own word, so it is left alone.
    expect(purposeAsNamedHere('Transit')).toBe('Transit');
    expect(purposeAsNamedHere(null)).toBe(null);
  });

  it('reads a hotel booking as a hotel', () => {
    expect(stayAsNamedHere('hotel')).toBe('Hotel');
    expect(stayAsNamedHere('apartment')).toBe('Residential');
    expect(stayAsNamedHere('Others')).toBe('Others');
    expect(stayAsNamedHere(null)).toBe(null);
  });

  it('searches administrative dropdowns by the stable place name', () => {
    // The two immigration sites wrap the same name differently. The e-visa
    // says `HO CHI MINH City` and `PHUONG TAN BINH`; the declaration may say
    // `Ho Chi Minh City` and `Tan Binh Ward`. The name in the middle is what
    // remains stable and uniquely filters the live dropdown.
    expect(provinceAsNamedHere('HO CHI MINH City')).toBe('HO CHI MINH');
    expect(provinceAsNamedHere('Khanh Hoa Province')).toBe('Khanh Hoa');
    expect(wardAsNamedHere('PHUONG TAN BINH')).toBe('TAN BINH');
    expect(wardAsNamedHere('XA VINH HAI')).toBe('VINH HAI');
    expect(wardAsNamedHere('Nha Trang Ward')).toBe('Nha Trang');
    expect(wardAsNamedHere('Cam Hai Dong Commune')).toBe('Cam Hai Dong');
  });

  it('has no field for the border gate, which the site fills itself', () => {
    // Read off the live site: the gate is disabled and takes its value from
    // the flight. A field for it here would be one nothing could ever fill.
    expect(TRIP_FIELDS.some((one) => one.key === 'borderGate')).toBe(false);
    expect(TRIP_FIELDS.some((one) => one.key === 'vehicleNumber')).toBe(true);
  });

  it('gives the flight list longer than a redraw', () => {
    // The list is fetched as the number is typed and answers the letters that
    // were in the box when the request went out, so it needs a real wait.
    expect(FLIGHT_LIST_MS >= 15000).toBe(true);
  });

  it('does not call optional fields or the selected Hotel default missing', async () => {
    const selected = {
      waitFor: async () => {},
      isChecked: async () => true,
    };
    const page = {
      locator: () => ({ first: () => selected }),
    };
    const result = await fillTrip(page, {});
    expect(result.missing.includes('workplace')).toBe(false);
    expect(result.missing.includes('vehicleNumber')).toBe(true);
    expect(result.missing.includes('departureDate')).toBe(false);
    expect(result.missing.includes('accommodationType')).toBe(false);
  });

  it('reads the selected radio labels without relying on their names', async () => {
    const page = {
      locator: (selector) => ({
        first: () => ({
          inputValue: async () => null,
          isChecked: async () => /(?:Air|Hotel)/.test(selector),
        }),
      }),
    };
    const read = await readTrip(page);
    expect(read.modeOfTravel).toBe('Air');
    expect(read.accommodationType).toBe('Hotel');
  });
});

describe('capturing pages without interrupting the batch', () => {
  const run = readFileSync('src/evisa-arrival-run.mjs', 'utf8');

  it('reads the form back only on the page those fields are on', () => {
    // readDeclaration asks for every field of the passenger page. Called
    // while the trip page is up, each of the fourteen waits out its own
    // twenty-second timeout for a field that page has not got — four and a
    // half minutes of a traveller watching a bot that looks dead. Measured:
    // the walk hung there until it was killed.
    const showing = run.slice(
      run.indexOf('async function captureThePage'),
      run.indexOf('function whatIsStillWanted')
    );
    expect(showing.includes('readDeclaration')).toBe(true);
    // Guarded by the page it is on, whichever way that is spelled.
    const guarded = /at === 0\s*\?\s*await readDeclaration/.test(showing);
    expect(guarded).toBe(true);
    // The trip caption must likewise describe the values visibly standing on
    // page two; passing an empty object produced a blank "current" section.
    expect(showing.includes('readTrip')).toBe(true);
    expect(/at === 1\s*\?\s*await readTrip/.test(showing)).toBe(true);
  });

  it('sends no progress reply while a page is being captured', () => {
    const showing = run.slice(
      run.indexOf('async function captureThePage'),
      run.indexOf('function whatIsStillWanted')
    );
    expect(showing.includes('ctx.reply')).toBe(false);
    expect(showing.includes('replyWithPhoto')).toBe(false);
  });
});

describe('the declaration is filed only on the traveller´s word', () => {
  const walk = readFileSync('src/evisa-prearrival-pages.mjs', 'utf8');

  it('keeps the filing out of the walk entirely', () => {
    // The filing lives in a function of its own. A walk that could file at
    // the end would sit one press away from filing by mistake, and an
    // immigration department does not hand a declaration back.
    const walkBody = walk.slice(
      walk.indexOf('export async function walkTheDeclaration'),
      walk.indexOf('export async function fileTheDeclaration')
    );
    // It names the review as a step to reach — "Review & Submit" is what the
    // site calls that page — and never presses the button on it.
    expect(/name:\s*\/\^?Submit/.test(walkBody)).toBe(false);
    expect(/\bcheck\(/.test(walkBody)).toBe(false);
    expect(walkBody.includes('fileTheDeclaration(')).toBe(false);
  });

  it('guards the filing before it touches anything', () => {
    // The check comes first in the function, so no path reaches the box or
    // the button without passing it.
    const filing = walk.slice(
      walk.indexOf('export async function fileTheDeclaration')
    );
    const guard = filing.indexOf('confirmed !== true');
    const box = filing.indexOf('check(');
    const press = filing.indexOf('Submit');
    expect(guard > 0).toBe(true);
    expect(guard < box).toBe(true);
    expect(guard < press).toBe(true);
  });
});
