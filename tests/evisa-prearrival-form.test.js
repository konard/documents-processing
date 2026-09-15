import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';
import { buildDeclaration } from '../src/evisa-prearrival.mjs';
import {
  FORM_FIELDS,
  selectorFor,
  nationalityAsNamedHere,
  chooseArrivalDate,
  fillDeclaration,
  chooseGender,
  acknowledgeVisaNotes,
  splitPhone,
  whatThisSiteWillRefuse,
  visaNumberAsNamedHere,
  PASSPORT_MARGIN_DAYS,
  PREARRIVAL_FORM_URL,
  ARRIVAL_WINDOW_DAYS,
  FIELD_TIMEOUT_MS,
  GONE_TIMEOUT_MS,
  choosePhoneCountryCode,
  chooseFrom,
  valueAsNamedHere,
  halfOfName,
  whatTheReadingsDisagreeOn,
  PASSPORT_FIELDS,
  photographDeclaration,
  uploadPassport,
  PASSPORT_READ_MS,
  readDeclaration,
} from '../src/evisa-prearrival-form.mjs';

describe('the declaration form the site actually draws', () => {
  it('numbers each passenger, which is how the site tells a party apart', () => {
    // Read off the page: 0_passportNumber, 0_dob, 0_visaNumber. A second
    // traveller added to the same declaration is 1_, and so on.
    const field = FORM_FIELDS.find((one) => one.key === 'passportNumber');
    expect(selectorFor(field, 0)).toBe('[name="0_passportNumber"]');
    expect(selectorFor(field, 1)).toBe('[name="1_passportNumber"]');
  });

  it('names the visa fields as the site names them, not as the visa form does', () => {
    // The declaration asks for the granted visa, which the application form
    // never held: these four have no counterpart there.
    for (const key of [
      'visaNumber',
      'visaIssueDate',
      'visaExpiryDate',
      'visaType',
    ]) {
      const field = FORM_FIELDS.find((one) => one.key === key);
      expect(`${key}:${Boolean(field)}`).toBe(`${key}:true`);
    }
  });

  it('finds the two fields the page leaves unnamed by their label', () => {
    // Surname and Given Name carry no name attribute; their labels point at
    // ids React generates fresh on every render (":re:", ":rf:"), so a
    // selector built from one would not survive a redraw.
    for (const key of ['surname', 'givenName']) {
      const field = FORM_FIELDS.find((one) => one.key === key);
      expect(field.name).toBe(undefined);
      expect(typeof field.label).toBe('string');
    }
  });

  it('calls Russia what this site calls it', () => {
    // The visa form says "Russia" and this one says "Russian Federation", so
    // the value that filled the application matches no option here.
    expect(nationalityAsNamedHere('Russia')).toBe('Russian Federation');
    expect(nationalityAsNamedHere('russia')).toBe('Russian Federation');
    // Anything already spelled the site's way is left alone.
    expect(nationalityAsNamedHere('Germany')).toBe('Germany');
    expect(nationalityAsNamedHere(null)).toBe(null);
  });
});

describe('the three-day window the site allows', () => {
  it('reports a landing the site is too early to take', async () => {
    // The form offers today and the two days after, as buttons, with no way
    // to type a fourth. A traveller landing beyond that has nothing to file
    // yet, and the nearest offered day is a false arrival date.
    const offered = ['12/09/2026', '13/09/2026', '14/09/2026'];
    const page = {
      locator: () => ({ allTextContents: async () => offered }),
      getByRole: () => {
        throw new Error('nothing should be clicked for a date not offered');
      },
    };
    const picked = await chooseArrivalDate(page, '17/09/2026');
    expect(picked.tooEarly).toBe(true);
    expect(picked.chosen).toBe(null);
    expect(picked.offered).toEqual(offered);
  });

  it('picks the day when the site does offer it', async () => {
    const clicked = [];
    const page = {
      locator: () => ({
        allTextContents: async () => ['12/09/2026', '13/09/2026'],
      }),
      getByRole: (role, options) => ({
        click: async () => clicked.push(`${role}:${options.name}`),
      }),
    };
    const picked = await chooseArrivalDate(page, '13/09/2026');
    expect(picked.tooEarly).toBe(false);
    expect(picked.chosen).toBe('13/09/2026');
    expect(clicked).toEqual(['button:13/09/2026']);
  });

  it('counts the window in days, so the reason can be explained', () => {
    expect(ARRIVAL_WINDOW_DAYS).toBe(3);
  });

  it('touches nothing else on a declaration it is too early to make', async () => {
    // The date is settled first. A day the site will not offer ends the fill,
    // and a form about to be abandoned should not be left with a box ticked
    // and a gender chosen on it.
    const touched = [];
    const page = {
      locator: () => ({ allTextContents: async () => ['12/09/2026'] }),
      getByRole: (role) => {
        touched.push(role);
        return { first: () => ({ isVisible: async () => true }) };
      },
    };
    const result = await fillDeclaration(page, {
      arrivalDate: '17/09/2026',
      sex: 'Male',
      surname: 'TRAVELLER',
    });
    expect(result.arrival.tooEarly).toBe(true);
    expect(touched).toEqual([]);
    expect(result.filled).toEqual([]);
  });
});

describe('the passport read twice', () => {
  const APPLICANT = {
    passportNumber: '712345678',
    surname: 'TRAVELLER',
    givenName: 'JOHN',
    dateOfBirth: '04/11/1988',
  };

  it('names the fields the two readings disagree on', () => {
    // The site reads the uploaded picture on its own server; the bot read the
    // same picture when it arrived. One of them has the birthday wrong — a
    // 3 and an 8 are a common pair to confuse — and only the traveller
    // holding the passport can say which.
    const differs = whatTheReadingsDisagreeOn(
      { ...APPLICANT, dateOfBirth: '04/11/1983' },
      APPLICANT
    );
    expect(differs.length).toBe(1);
    expect(differs[0].key).toBe('dateOfBirth');
    expect(differs[0].site).toBe('04/11/1983');
    expect(differs[0].bot).toBe('04/11/1988');
  });

  it('says nothing when both readings agree', () => {
    expect(whatTheReadingsDisagreeOn({ ...APPLICANT }, APPLICANT)).toEqual([]);
  });

  it('passes over a field only one of them read', () => {
    // A blank on either side is a reading not attempted. Called a
    // disagreement, every field the site leaves empty becomes a question the
    // traveller is asked for no reason.
    expect(
      whatTheReadingsDisagreeOn({ passportNumber: '' }, APPLICANT)
    ).toEqual([]);
    expect(
      whatTheReadingsDisagreeOn({ passportNumber: '712345678' }, {})
    ).toEqual([]);
  });

  it('reads the same letters in either case as agreement', () => {
    // The site prints a surname back in capitals whatever was typed.
    expect(
      whatTheReadingsDisagreeOn({ surname: 'traveller' }, APPLICANT)
    ).toEqual([]);
  });

  it('compares only what a passport picture can say', () => {
    // The visa number and the flight come from other documents entirely, so
    // the site reading nothing for them is not a disagreement.
    expect(PASSPORT_FIELDS.includes('visaNumber')).toBe(false);
    expect(PASSPORT_FIELDS.includes('arrivalDate')).toBe(false);
    expect(PASSPORT_FIELDS.includes('passportNumber')).toBe(true);
    expect(PASSPORT_FIELDS.includes('dateOfBirth')).toBe(true);
  });

  it("takes an empty date field's format hint for the blank it is", () => {
    // Read off the live site: a date the site filled nothing into gives back
    // "DD/MM/YYYY", which is what it wants typed, not what it read. Reported
    // as a disagreement it is pure noise, and a traveller who learns the
    // disagreements are noise stops reading the one that is real.
    expect(
      whatTheReadingsDisagreeOn(
        { dateOfBirth: 'DD/MM/YYYY', passportExpiryDate: 'DD/MM/YYYY' },
        { ...APPLICANT, passportExpiryDate: '01/01/2030' }
      )
    ).toEqual([]);
  });

  it('still reports a real date the two readings differ on', () => {
    // The hint is passed over; an actual date is not.
    const differs = whatTheReadingsDisagreeOn(
      { dateOfBirth: '04/11/1983' },
      APPLICANT
    );
    expect(differs.length).toBe(1);
    expect(differs[0].site).toBe('04/11/1983');
  });
});

describe('the one phone number the traveller gives', () => {
  it('is split into the two fields the site asks for', () => {
    // The site has a Country Code beside the Phone Number. Typed whole into
    // the number, the code goes in twice and the site refuses it.
    expect(splitPhone('+7 912 345 67 89')).toEqual({
      phoneCountryCode: '7',
      phone: '9123456789',
    });
  });

  it('takes the longest code that fits, not the first that matches', () => {
    // Read shortest-first, +995 is taken for +9 and Georgia is declared
    // something else. Kazakhstan shares +7 with Russia and the site offers
    // one entry for the pair, so a Kazakh number keeps the +7 it shares.
    expect(splitPhone('+995 555 123456').phoneCountryCode).toBe('995');
    expect(splitPhone('+7 701 234 5678').phoneCountryCode).toBe('7');
  });

  it('guesses no country for a number given without one', () => {
    // A bare number is a local one. Naming a country for it would put a
    // stranger's telephone on a government declaration.
    expect(splitPhone('912 345 67 89')).toEqual({
      phoneCountryCode: null,
      phone: '9123456789',
    });
  });

  it('has nothing to split when no number was given', () => {
    expect(splitPhone(null).phone).toBe(null);
    expect(splitPhone('').phoneCountryCode).toBe(null);
  });

  it('sets the dialling code only after every passport-driven redraw', () => {
    // The live site can redraw Country Code while it finishes reading the
    // uploaded passport. Choosing the code before that scan reported success
    // and then left the required control blank by the time Next was pressed.
    const source = readFileSync('src/evisa-prearrival-form.mjs', 'utf8');
    const start = source.indexOf('export async function fillDeclaration');
    const end = source.indexOf('/**\n * The fields where', start);
    const filling = source.slice(start, end);
    expect(filling.indexOf('for (const field of FORM_FIELDS)')).toBeLessThan(
      filling.indexOf('finishPhoneCountryCode')
    );
  });

  it('reads the dialling code back with the rest of the passenger page', async () => {
    // A fill claim is useful only if the value survived on the final page.
    const empty = { first: () => ({ inputValue: async () => '' }) };
    const page = {
      locator: (selector) =>
        selector === '[name="0_phoneCountryCode"]'
          ? { first: () => ({ inputValue: async () => '(+7)' }) }
          : empty,
      getByLabel: () => empty,
    };
    expect(await readDeclaration(page)).toEqual({ phoneCountryCode: '(+7)' });
  });

  it('reads every passenger value the chat promises to show', async () => {
    const fields = {
      '[name="0_phone"]': '2025550123',
      '[name="0_phoneCountryCode"]': '(+1)',
    };
    const input = (value = '') => ({
      first: () => ({ inputValue: async () => value }),
    });
    const page = {
      locator: (selector) =>
        selector === 'button, label'
          ? { allTextContents: async () => ['14/09/2026', '15/09/2026'] }
          : input(fields[selector]),
      getByLabel: (label) =>
        input(String(label).includes('Given') ? 'JORDAN' : 'TRAVELLER'),
      getByRole: (role, { name }) => ({
        first: () => ({ isChecked: async () => name === 'Male' }),
        getAttribute: async (attribute) =>
          role === 'button' &&
          name === '15/09/2026' &&
          attribute === 'aria-pressed'
            ? 'true'
            : null,
      }),
    };

    const read = await readDeclaration(page);
    expect(read.fullName).toBe('TRAVELLER JORDAN');
    expect(read.gender).toBe('Male');
    expect(read.arrivalDate).toBe('15/09/2026');
    expect(read.phone).toBe('+12025550123');
  });
});

describe('what the site will refuse, said before it refuses it', () => {
  const fine = {
    visaType: 'Electronic Visa (E-Visa)',
    visaNumber: '712345678',
    visaExpiryDate: '01/11/2026',
    passportExpiryDate: '01/01/2031',
  };

  it('takes a declaration the site has no objection to', () => {
    expect(whatThisSiteWillRefuse(fine)).toEqual([]);
  });

  it('takes the number as the granted visa prints it', () => {
    // The Số / No. line reads "712345678/EV" and that is how the visa is read
    // and stored. This form wants the digits alone, so the suffix comes off
    // here and a real granted visa is not reported as refused.
    expect(
      whatThisSiteWillRefuse({ ...fine, visaNumber: '712345678/EV' })
    ).toEqual([]);
    expect(visaNumberAsNamedHere('712345678/EV')).toBe('712345678');
    expect(visaNumberAsNamedHere('712345678')).toBe('712345678');
    expect(visaNumberAsNamedHere(null)).toBe(null);
  });

  it('wants the nine digits off the visa, not the application code', () => {
    // The help behind the (?) beside the field: "The E-Visa number must be
    // numeric and 9 digits long." It is the Số / No. line on the visa itself.
    const refused = whatThisSiteWillRefuse({
      ...fine,
      visaNumber: 'E1234567890',
    });
    expect(refused.map((one) => one.key)).toEqual(['visaNumber']);
    expect(refused[0].why).toBe('nineDigits');
  });

  it('says nothing about the number on a visa that is not electronic', () => {
    // The rule is the e-visa's. A paper visa's number is its own shape.
    expect(
      whatThisSiteWillRefuse({ ...fine, visaType: 'Visa', visaNumber: 'B3-12' })
    ).toEqual([]);
  });

  it('wants the passport to outlast the visa by a month', () => {
    // "An electronic visa must expire at least 30 days before the passport
    // expires." A passport running out too soon is a trip to renew it.
    const refused = whatThisSiteWillRefuse({
      ...fine,
      visaExpiryDate: '01/11/2026',
      passportExpiryDate: '15/11/2026',
    });
    expect(refused.map((one) => one.key)).toEqual(['passportExpiryDate']);
    expect(refused[0].days).toBe(14);
    expect(PASSPORT_MARGIN_DAYS).toBe(30);
  });

  it('judges nothing on a date it cannot read', () => {
    // A date the record has not got is missing, and is reported as missing.
    // Calling it refused would name a field the traveller never filled.
    expect(whatThisSiteWillRefuse({ ...fine, passportExpiryDate: '' })).toEqual(
      []
    );
  });
});

describe('the controls that are not text', () => {
  /**
   * A radio or checkbox that answers like Material UI's does.
   *
   * `takes` says which ways in the control accepts: `check` for one that sets
   * from its own input, `label` for one whose handler hangs on the label, and
   * `dispatch` for one that only listens. The site has drawn all three.
   */
  function control({ checked = false, takes = true, disabled = false } = {}) {
    const state = { checked, clicked: [] };
    const accepts = (way) =>
      takes === true ? way === 'check' : [].concat(takes).includes(way);
    const set = (way) => {
      state.clicked.push(way);
      if (accepts(way)) {
        state.checked = true;
      }
    };
    const label = {
      click: async () => set('label'),
    };
    return {
      state,
      label,
      waitFor: async () => {},
      isVisible: async () => true,
      isDisabled: async () => disabled,
      isChecked: async () => state.checked,
      check: async () => {
        set('check');
        if (!accepts('check')) {
          throw new Error('Clicking the checkbox did not change its state');
        }
      },
      dispatchEvent: async () => set('dispatch'),
      // The ancestor label, reached the way chooseGender reaches it.
      locator: () => ({ or: () => ({ first: () => label }) }),
    };
  }

  /** A page holding one control, which is all these ask for. */
  const pageWith = (one) => ({
    getByRole: () => ({ first: () => one }),
    getByText: () => one.label,
    locator: () => ({ filter: () => ({ first: () => one.label }) }),
  });

  it('reads the gender back, so a tick that did not take is reported', () => {
    // The radio's input is zero-sized under a drawn circle, and a click that
    // lands on the decoration leaves the field blank. Reported filled, it
    // left a required answer empty on a page that looked complete.
    const radio = control({ takes: [] });
    const page = pageWith(radio);
    return chooseGender(page, 'Male').then(
      () => {
        throw new Error('a tick that did not take was reported as filled');
      },
      (error) => expect(error.message.includes('would not tick')).toBe(true)
    );
  });

  it('ticks the gender the traveller gave', async () => {
    const radio = control();
    const asked = [];
    const page = {
      ...pageWith(radio),
      getByRole: (role, options) => {
        asked.push(`${role}:${options.name}`);
        return { first: () => radio };
      },
    };
    expect(await chooseGender(page, 'Female')).toBe('Female');
    expect(asked).toEqual(['radio:Female']);
    expect(radio.state.checked).toBe(true);
  });

  it('clicks the label when the input swallows the click', async () => {
    // Material UI hangs its handler on the label, and React rerenders over an
    // input clicked directly, putting it back the way it was. This is the
    // failure the live form actually gave: "Clicking the checkbox did not
    // change its state", with the gender left blank on a page reported full.
    const radio = control({ takes: 'label' });
    expect(await chooseGender(pageWith(radio), 'Male')).toBe('Male');
    expect(radio.state.checked).toBe(true);
    expect(radio.state.clicked).toEqual(['check', 'label']);
  });

  it('dispatches the event when nothing can be clicked', async () => {
    const radio = control({ takes: 'dispatch' });
    expect(await chooseGender(pageWith(radio), 'Male')).toBe('Male');
    expect(radio.state.clicked).toEqual(['check', 'label', 'dispatch']);
  });

  it('stops at the first way in that works', async () => {
    const radio = control({ takes: 'check' });
    await chooseGender(pageWith(radio), 'Male');
    expect(radio.state.clicked).toEqual(['check']);
  });

  it('refuses to force a control the site has locked', async () => {
    // Dispatching a click at a disabled input does set `checked`, which would
    // report a gender the form has not got.
    const radio = control({ disabled: true });
    return chooseGender(pageWith(radio), 'Male').then(
      () => {
        throw new Error('a disabled radio was reported as ticked');
      },
      (error) => expect(error.message.includes('disabled')).toBe(true)
    );
  });

  it('ticks the box that unlocks the visa section', async () => {
    // "Please check this box to continue": until it is ticked the site holds
    // the visa fields behind an error and refuses everything typed there.
    const box = control();
    const page = pageWith(box);
    expect(await acknowledgeVisaNotes(page)).toBe(true);
    expect(box.state.checked).toBe(true);
  });

  it('leaves a box the site already ticked alone', async () => {
    const box = control({ checked: true });
    const page = pageWith(box);
    expect(await acknowledgeVisaNotes(page)).toBe(true);
  });
});

describe('the declaration is never sent on the traveller´s behalf', () => {
  const source = readFileSync('src/evisa-prearrival-form.mjs', 'utf8');

  it('presses nothing that files the declaration', () => {
    // The bot fills and shows; the last press is the traveller's, as it is
    // for the visa. This is a real filing with a government department.
    expect(/getByRole\([^)]*Submit/i.test(source)).toBe(false);
    expect(source.includes("name: 'Submit'")).toBe(false);
  });

  it('drives the site the site is, not the one next door', () => {
    // The visa form is Ant Design addressed by id; this is Material UI
    // addressed by name. Borrowing those helpers types into nothing.
    expect(source.includes('evisa-fill.mjs')).toBe(false);
    expect(
      PREARRIVAL_FORM_URL.startsWith('https://prearrival.immigration.gov.vn')
    ).toBe(true);
  });
});

describe('putting the passport on the page', () => {
  /**
   * A form that fills itself in from an uploaded passport, after a delay.
   *
   * This is what the live site does: the picture goes to its server, and the
   * fields it reads off the zone appear a second or three later. `after` says
   * how many polls it takes, so a test can make the site slower than any
   * fixed sleep would allow for.
   */
  function siteThatReads(values, { after = 2 } = {}) {
    const page = { uploaded: null, polls: 0, waited: null };
    let polls = 0;
    const onThePage = () => (polls >= after ? values : {});
    globalThis.document = {
      querySelector: (one) => {
        const match = /\[name="(?:\d+_)?([^"]+)"\]/.exec(one);
        const key = match?.[1];
        const found = Object.entries(onThePage()).find(
          ([, v]) => v.name === key
        );
        return found ? { value: found[1].value } : null;
      },
    };
    page.setInputFiles = async (where, file) => {
      page.uploaded = { where, file };
    };
    page.waitForFunction = async (fn, arg, opts) => {
      page.waited = opts;
      for (let i = 0; i < 20; i += 1) {
        polls += 1;
        if (fn(arg)) {
          return true;
        }
      }
      throw new Error('Timeout exceeded');
    };
    const fieldNamed = (one) => {
      const match = /\[name="(?:\d+_)?([^"]+)"\]/.exec(one);
      const key = match?.[1];
      const found = Object.entries(onThePage()).find(([, v]) => v.name === key);
      const value = found?.[1].value;
      return {
        first: () => ({
          inputValue: async () => {
            if (value === undefined) {
              throw new Error('no such field');
            }
            return value;
          },
        }),
      };
    };
    page.locator = fieldNamed;
    page.getByLabel = () => ({
      first: () => ({
        inputValue: async () => {
          throw new Error('no such field');
        },
      }),
    });
    return page;
  }

  /** The site's reading, keyed the way the page names each field. */
  const READ_BACK = {
    passportNumber: { name: 'passportNumber', value: '712345678' },
    dateOfBirth: { name: 'dob', value: '04/11/1983' },
  };

  it('waits for the site to read the picture, not for a fixed sleep', async () => {
    // Measured on the live site: the values land anywhere between half a
    // second and three. A fixed sleep is a coin toss, and losing it means
    // reading an empty page and calling that the site's opinion.
    const page = siteThatReads(READ_BACK, { after: 6 });
    const { took, site } = await uploadPassport(page, '/tmp/passport.png');
    expect(took).toBe(true);
    expect(site.passportNumber).toBe('712345678');
  });

  it('puts the file on the input the site actually has', async () => {
    const page = siteThatReads(READ_BACK);
    await uploadPassport(page, '/tmp/passport.png');
    expect(page.uploaded.where).toBe('input[name="passportImage"]');
    expect(page.uploaded.file).toBe('/tmp/passport.png');
  });

  it('says the site read nothing when it reads nothing', async () => {
    // A file that went up and taught the site nothing leaves no second
    // opinion to check the bot's reading against. Silence here would let an
    // empty page pass for agreement with whatever the bot typed.
    const page = siteThatReads({});
    const { took, site } = await uploadPassport(page, '/tmp/passport.png');
    expect(took).toBe(false);
    expect(site).toEqual({});
  });

  it("does not take a date field's format hint for a reading", async () => {
    // An empty date on this form reads back as "DD/MM/YYYY". Counted as a
    // value, it ends the wait early and then claims the site read something.
    const page = siteThatReads({
      dateOfBirth: { name: 'dob', value: 'DD/MM/YYYY' },
    });
    const { took } = await uploadPassport(page, '/tmp/passport.png');
    expect(took).toBe(false);
  });

  it('gives the site longer than it has ever taken', async () => {
    // Three seconds was the old sleep and the live site has come close to it.
    expect(PASSPORT_READ_MS >= 30000).toBe(true);
  });

  it('holds the two placeholder tests to the same answer', () => {
    // The wait runs inside the browser, so it cannot call the helper and
    // spells the test out again. Two copies drift apart unless something
    // holds them together.
    const inTheWait = /^[DMY]{1,4}([/-][DMY]{1,4})+$/i;
    const source = readFileSync('src/evisa-prearrival-form.mjs', 'utf8');
    const copies = source.match(/\[DMY\]\{1,4\}\(\[\/-\]\[DMY\]\{1,4\}\)\+/g);
    expect(copies.length).toBe(2);
    for (const hint of ['DD/MM/YYYY', 'dd/mm/yyyy', 'YYYY-MM-DD', 'MM/YYYY']) {
      expect(inTheWait.test(hint)).toBe(true);
    }
    for (const real of ['04/11/1983', '01/01/2030', 'TRAVELLER']) {
      expect(inTheWait.test(real)).toBe(false);
    }
  });
});

describe('photographing the filled declaration', () => {
  /**
   * A page with the site's sticky header on it.
   *
   * The real one is a Material UI AppBar that follows the viewport down. In a
   * full-page picture it is drawn wherever the viewport happens to stand, so
   * it lands across the middle of the form. The stub records the header's
   * position at the moment the exposure is taken, which is the only thing
   * that decides where it appears.
   */
  function pageWithStickyHeader() {
    const bar = { style: { position: '', top: '' }, dataset: {} };
    const active = {
      blurred: false,
      blur() {
        this.blurred = true;
      },
    };
    const seen = [];
    globalThis.document = {
      activeElement: active,
      querySelector: (what) => (what === 'header' ? bar : null),
    };
    globalThis.getComputedStyle = (el) => ({
      position: el.style.position || 'sticky',
    });
    return {
      bar,
      active,
      seen,
      page: {
        evaluate: async (fn) => fn(),
        screenshot: async () => {
          seen.push(bar.style.position);
          return Buffer.from('picture');
        },
      },
    };
  }

  it('pins the floating bar to the top before the exposure', async () => {
    // Left sticky, the bar is drawn at the viewport's offset and covers a row
    // of the form — on a real fill, the passport type and number. The picture
    // is the whole point of the message, so a row missing from it is the row
    // the traveller cannot check.
    const { page, seen } = pageWithStickyHeader();
    const shot = await photographDeclaration(page);
    expect(shot.toString()).toBe('picture');
    expect(seen).toEqual(['absolute']);
  });

  it('removes the last input focus before the exposure', async () => {
    const { page, active } = pageWithStickyHeader();
    await photographDeclaration(page);
    expect(active.blurred).toBe(true);
  });

  it('gives the page back the way it was found', async () => {
    // This is still the declaration the traveller is about to send. A style
    // the bot left behind is a change to the page nobody asked for.
    const { page, bar } = pageWithStickyHeader();
    await photographDeclaration(page);
    expect(bar.style.position).toBe('');
    expect(bar.style.top).toBe('');
    expect('wasPositioned' in bar.dataset).toBe(false);
  });

  it('photographs a page that has no such bar', async () => {
    // Nothing to pin, and the picture is taken all the same.
    globalThis.document = { querySelector: () => null };
    const page = {
      evaluate: async (fn) => fn(),
      screenshot: async () => Buffer.from('plain'),
    };
    expect((await photographDeclaration(page)).toString()).toBe('plain');
  });
});

describe('what a failure looks like to someone reading a chat', () => {
  it('keeps the reason and drops the call log', async () => {
    // A Playwright error carries forty lines of selectors and click actions
    // in `message`. All of it reached the chat, under the traveller's own
    // values, as a wall of "waiting for locator(...)".
    const { saidBriefly } = await import('../src/evisa-messages.mjs');
    const escape = String.fromCharCode(27);
    const said = saidBriefly(
      new Error(
        'locator.check: Clicking the checkbox did not change its state\n' +
          'Call log:\n' +
          `${escape}[2m  - waiting for getByRole('radio')${escape}[22m\n` +
          `${escape}[2m  - attempting click action${escape}[22m`
      )
    );
    expect(said).toBe(
      'locator.check: Clicking the checkbox did not change its state'
    );
  });

  it('strips the dimming codes, escape or no escape', async () => {
    const { saidBriefly } = await import('../src/evisa-messages.mjs');
    // Telegram shows these as a literal "[2m" where the escape was lost on
    // the way through, so both spellings have to go.
    expect(saidBriefly('[2m  - waiting for locator(x)[22m')).toBe(
      '- waiting for locator(x)'
    );
  });

  it('caps a single line that runs on', async () => {
    const { saidBriefly } = await import('../src/evisa-messages.mjs');
    const said = saidBriefly(new Error('x'.repeat(500)));
    expect(said.length).toBe(120);
    expect(said.endsWith('...')).toBe(true);
  });

  it('takes something that is not an error at all', async () => {
    const { saidBriefly } = await import('../src/evisa-messages.mjs');
    expect(saidBriefly('plain words')).toBe('plain words');
    expect(saidBriefly(null)).toBe('null');
  });
});

describe('a form the site never drew', () => {
  /**
   * A page with no fields on it, counting what each wait was asked to allow.
   *
   * This is the declaration as it stands when the nationality never took: the
   * site draws nothing until one is chosen, so every field behind it is
   * absent and every wait for one runs out.
   */
  function emptyPage(waits) {
    const input = {
      isDisabled: async () => false,
      inputValue: async () => '',
      waitFor: async ({ timeout }) => {
        waits.push(timeout);
        throw new Error(`locator.waitFor: Timeout ${timeout}ms exceeded.`);
      },
    };
    return {
      locator: () => ({
        first: () => input,
        allTextContents: async () => [],
      }),
      getByRole: () => ({ first: () => input }),
      getByLabel: () => ({ first: () => input }),
    };
  }

  it('asks briefly for the fields after the first one that is absent', async () => {
    // Three fields timing out at twenty seconds apiece spent a minute
    // learning the same thing, while the chat said nothing at all.
    const waits = [];
    const result = await fillDeclaration(emptyPage(waits), {
      passportNumber: '712345678',
      surname: 'TRAVELLER',
      givenName: 'JOHN',
      email: 'traveller@example.com',
    });
    expect(result.filled).toEqual([]);
    expect(waits.length > 1).toBe(true);
    // The first pays the full wait, since a field arriving late is normal.
    expect(waits[0]).toBe(FIELD_TIMEOUT_MS);
    // Every one after it is asked briefly.
    expect(waits.slice(1).every((one) => one === GONE_TIMEOUT_MS)).toBe(true);
  });

  it('names every absent field, so none is passed over in silence', async () => {
    const waits = [];
    const result = await fillDeclaration(emptyPage(waits), {
      passportNumber: '712345678',
      surname: 'TRAVELLER',
    });
    // The box that unlocks the visa section is not drawn either, and is
    // reported alongside the fields.
    const named = result.failed.map((one) => one.split(':')[0]);
    expect(named.includes('passportNumber')).toBe(true);
    expect(named.includes('surname')).toBe(true);
    expect(result.filled).toEqual([]);
  });

  it('keeps the full wait while fields are going in', async () => {
    // A form that is being drawn in pieces must not be cut short by one slow
    // field: the short wait is for a form that is not there at all.
    const waits = [];
    const page = emptyPage(waits);
    let seen = 0;
    const good = {
      isDisabled: async () => false,
      inputValue: async () => '712345678',
      waitFor: async ({ timeout }) => waits.push(timeout),
      click: async () => {},
      press: async () => {},
      type: async () => {},
    };
    page.locator = () => ({
      first: () => (seen++ === 0 ? good : good),
      allTextContents: async () => [],
    });
    page.getByLabel = () => ({ first: () => good });
    await fillDeclaration(page, {
      passportNumber: '712345678',
      surname: 'TRAVELLER',
    });
    expect(waits.every((one) => one === FIELD_TIMEOUT_MS)).toBe(true);
  });

  it('does not call an absent dialling-code control filled', async () => {
    // A redraw can briefly remove the control. Returning null from its helper
    // must be a visible failure, not a successful fill that Next later rejects.
    const waits = [];
    const page = emptyPage(waits);
    const absentCode = {
      isVisible: async () => false,
      inputValue: async () => '',
    };
    const locate = page.locator;
    page.locator = (selector) =>
      selector === '[name="0_phoneCountryCode"]'
        ? { first: () => absentCode }
        : locate(selector);
    const result = await fillDeclaration(page, { phone: '+7 912 345 67 89' });
    expect(result.filled.includes('phoneCountryCode')).toBe(false);
    expect(
      result.failed.some((one) => one.startsWith('phoneCountryCode:'))
    ).toBe(true);
  });
});

describe('a dialling code several countries share', () => {
  /** A list that offers the given options, recording which was clicked. */
  function listOf(texts, clicked) {
    let selected = '';
    const input = {
      waitFor: async () => {},
      fill: async () => {},
      type: async () => {},
      isVisible: async () => true,
      inputValue: async () => selected,
    };
    const options = {
      first: () => ({ waitFor: async () => {} }),
      allTextContents: async () => texts,
      nth: (index) => ({
        click: async () => {
          clicked.push(texts[index]);
          selected = texts[index].match(/\(\+\d+\)/)?.[0] ?? texts[index];
        },
      }),
    };
    return {
      input,
      page: {
        locator: (what) =>
          what === '[role=option]' ? options : { first: () => input },
      },
    };
  }

  it('takes the first of the countries that share the code', async () => {
    // The site names each country separately, so "(+1)" is offered as the
    // United States, Canada and the Dominican Republic. All three put the
    // same code in the field, which is all the field holds.
    const clicked = [];
    const { page } = listOf(
      ['United States (+1)', 'Canada (+1)', 'Dominican Republic (+1)'],
      clicked
    );
    expect(await choosePhoneCountryCode(page, '1')).toBe('(+1)');
    expect(clicked).toEqual(['United States (+1)']);
  });

  it('still refuses where the options are not the same answer', async () => {
    // The list filters on the text typed, so asking for "(+1)" brings back
    // rows whose code is not +1 at all. A row naming two codes is not one
    // answer, and picking it would put the wrong code on a government form.
    const clicked = [];
    const { page } = listOf(
      ['United States (+1)', 'Elsewhere (+1) (+44)'],
      clicked
    );
    return choosePhoneCountryCode(page, '1').then(
      () => {
        throw new Error('a genuinely ambiguous list was not refused');
      },
      (error) => {
        expect(error.message.includes('matches')).toBe(true);
        expect(clicked).toEqual([]);
      }
    );
  });

  it('leaves an ambiguous nationality refused, as it was', async () => {
    // The allowance is passed only for the dialling code. Guessing at
    // somebody's nationality is still not safe.
    const clicked = [];
    const { page, input } = listOf(
      ['Republic of Sudan', 'South Sudan'],
      clicked
    );
    return chooseFrom(page, input, 'Sudan', 'nationality').then(
      () => {
        throw new Error('an ambiguous nationality was chosen anyway');
      },
      (error) => expect(error.message.includes('matches 2 of 2')).toBe(true)
    );
  });
});

describe('the name and gender the two sides spell differently', () => {
  it('fills Surname and Given Name from the one Full Name', async () => {
    // The declaration is described to the traveller as the filed copy prints
    // it: one Full Name, a Gender. This form asks for the two halves of the
    // name separately, so a record holding only the described shape left the
    // name blank on a page that reported itself full.
    const { values } = buildDeclaration({
      surname: 'TRAVELLER',
      givenName: 'JOHN ALEX',
      sex: 'Male',
      fullName: 'TRAVELLER JOHN ALEX',
    });
    expect(valueAsNamedHere({ key: 'surname' }, values)).toBe('TRAVELLER');
    expect(valueAsNamedHere({ key: 'givenName' }, values)).toBe('JOHN ALEX');
  });

  it('takes the gender whichever of the two names it arrives under', () => {
    // The declaration calls it Gender and this form calls it sex. Read under
    // one name only, the one required radio on the form went unticked.
    expect(valueAsNamedHere({ key: 'sex' }, { gender: 'Female' })).toBe(
      'Female'
    );
    expect(valueAsNamedHere({ key: 'sex' }, { sex: 'Male' })).toBe('Male');
  });

  it('prefers the halves the record already holds', () => {
    // A passport read straight into the record has both, and they are better
    // than anything split back out of a joined name.
    const said = { surname: 'DOE', givenName: 'JANE', fullName: 'WRONG NAME' };
    expect(valueAsNamedHere({ key: 'surname' }, said)).toBe('DOE');
    expect(valueAsNamedHere({ key: 'givenName' }, said)).toBe('JANE');
  });

  it('splits a name on the surname coming first', () => {
    expect(halfOfName('TRAVELLER JOHN ALEX', 'surname')).toBe('TRAVELLER');
    expect(halfOfName('TRAVELLER JOHN ALEX', 'givenName')).toBe('JOHN ALEX');
  });

  it('invents no given name for a name of one word', () => {
    // Guessing here would put a name nobody gave on a government form.
    expect(halfOfName('TRAVELLER', 'surname')).toBe('TRAVELLER');
    expect(halfOfName('TRAVELLER', 'givenName')).toBe(null);
    expect(halfOfName('', 'surname')).toBe(null);
    expect(halfOfName(null, 'givenName')).toBe(null);
  });
});
