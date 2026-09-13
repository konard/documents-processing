import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';
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
    const picked = await chooseArrivalDate(page, '[REDACTED]');
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
      arrivalDate: '[REDACTED]',
      sex: 'Male',
      surname: 'TRAVELLER',
    });
    expect(result.arrival.tooEarly).toBe(true);
    expect(touched).toEqual([]);
    expect(result.filled).toEqual([]);
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
