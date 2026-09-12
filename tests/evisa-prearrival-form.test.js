import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';
import {
  FORM_FIELDS,
  selectorFor,
  nationalityAsNamedHere,
  chooseArrivalDate,
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
    const picked = await chooseArrivalDate(page, '16/09/2026');
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
