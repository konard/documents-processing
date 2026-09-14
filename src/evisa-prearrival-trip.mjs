// evisa-prearrival-trip.mjs
//
// The declaration's second page: the trip.
//
// The first page is about the traveller and their passport, and this one is
// about the journey — where they flew in from, on what, and where they are
// staying. It is a page of its own because the site makes it one, and it is a
// module of its own because almost nothing about it is addressed the way the
// first page is.
//
// Four things here are not true of page one. Each was read off the live site:
//
//   * Its controls carry no usable name and no label binding. They are
//     comboboxes found by the heading printed above them. The ids React gives
//     them (":r12:", ":r16:") are made fresh on every render, so a selector
//     built from one dies at the next redraw.
//
//   * The border gate is permanently disabled and fills itself. Choosing the
//     flight sets it: picking "[REDACTED] - SGN" put "SGN -  Tan Son Nhat
//     International Airport" in it. Nothing can type into that field, so the
//     flight is what this driver sets and the gate is read back afterwards.
//
//   * The accommodation address offers one option, "Other", whatever the
//     province and ward are. Choosing it draws a new field —
//     customAccommodationAddress — which is where the street address goes.
//
//   * A heading that is mandatory prints its asterisk in a separate element,
//     so "Border Gate *" is matched by what the heading starts with and never
//     by its whole text.

import { chooseFrom, FIELD_TIMEOUT_MS } from './evisa-prearrival-form.mjs';
import { saidBriefly } from './evisa-messages.mjs';

/**
 * The site's own wording for a purpose of travel.
 *
 * Its list offers six, and a tourist e-visa says "Tourist" where this page
 * says "Travel". Anything already spelled the site's way is left alone.
 */
const PURPOSES = new Map([
  ['tourist', 'Travel'],
  ['tourism', 'Travel'],
  ['travel', 'Travel'],
  ['holiday', 'Travel'],
  ['business', 'Business trip'],
  ['business trip', 'Business trip'],
  ['work', 'Work'],
  ['study', 'Study abroad'],
  ['study abroad', 'Study abroad'],
  ['transit', 'Transit'],
]);

/** What this page calls the purpose the visa recorded. */
export function purposeAsNamedHere(purpose) {
  if (!purpose) {
    return null;
  }
  const said = String(purpose).trim();
  return PURPOSES.get(said.toLowerCase()) ?? said;
}

/**
 * The options offered for the type of accommodation.
 *
 * A hotel booking is a hotel; anything else a traveller writes about where
 * they are staying is somebody's home unless it names one of the other two.
 */
const STAYS = new Map([
  ['hotel', 'Hotel'],
  ['residential', 'Residential'],
  ['residence', 'Residential'],
  ['home', 'Residential'],
  ['house', 'Residential'],
  ['apartment', 'Residential'],
  ['other', 'Others'],
  ['others', 'Others'],
]);

/** What this page calls the kind of place the traveller is staying in. */
export function stayAsNamedHere(kind) {
  if (!kind) {
    return null;
  }
  const said = String(kind).trim().toLowerCase();
  return STAYS.get(said) ?? 'Hotel';
}

/**
 * The province as this page spells it.
 *
 * Its list prints the kind of place after the name — "Khanh Hoa Province" —
 * and a booking says "Khanh Hoa". The match is left to the list itself where
 * the name alone picks one option; this only supplies what the name alone
 * cannot.
 */
export function provinceAsNamedHere(province) {
  if (!province) {
    return null;
  }
  return String(province).trim();
}

/** The fields this page holds, by the heading printed above each one. */
export const TRIP_FIELDS = [
  {
    key: 'departedFrom',
    heading: 'Departure country before Arrival in Vietnam',
    how: 'combobox',
  },
  { key: 'purpose', heading: 'Purpose of Travel', how: 'combobox' },
  { key: 'modeOfTravel', heading: 'Mode of Travel', how: 'radio' },
  // The flight, and with it the border gate: the site fills the gate from
  // whichever flight is chosen, and will not let anything type into it.
  { key: 'vehicleNumber', heading: 'Flight Number', how: 'combobox' },
  { key: 'accommodationType', heading: 'Type of Accommodation', how: 'stay' },
  { key: 'province', heading: 'Province / City of Hotel', how: 'combobox' },
  { key: 'ward', heading: 'Ward / Commune of Hotel', how: 'combobox' },
  {
    key: 'accommodationAddress',
    heading: 'Accommodation Address',
    how: 'address',
  },
  { key: 'workplace', heading: 'Workplace Information', how: 'text' },
  {
    key: 'departureDate',
    heading: 'Expected date of departure from Vietnam',
    how: 'date',
  },
];

/**
 * The combobox printed under a heading.
 *
 * The heading is matched by what it starts with, since a mandatory one keeps
 * its asterisk in an element of its own and never reads as the bare words.
 */
export function boxUnder(page, heading) {
  const bare = String(heading).replace(/\s*\*$/, '');
  return page
    .locator(
      `xpath=//*[starts-with(normalize-space(text()), ${JSON.stringify(bare)})]` +
        `/following::input[@role='combobox'][1]`
    )
    .first();
}

/** The plain text input printed under a heading. */
export function fieldUnder(page, heading) {
  const bare = String(heading).replace(/\s*\*$/, '');
  return page
    .locator(
      `xpath=//*[starts-with(normalize-space(text()), ${JSON.stringify(bare)})]` +
        `/following::input[not(@role='combobox')][1]`
    )
    .first();
}

/** How long to let the site redraw after a choice that changes the page. */
export const CASCADE_MS = 1200;

/**
 * How long to wait for the flight list to come back with the flight in it.
 *
 * Longer than a cascade: this one is a request to the site's own service, and
 * it answers the letters typed at the time it was sent.
 */
export const FLIGHT_LIST_MS = 20000;

/** A value as a literal inside a regular expression. */
function escapeForSearch(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Chooses the flight, which is also how the border gate is filled.
 *
 * The gate is disabled on this form and takes its value from the flight, so
 * the flight is the only way in. The site prints its flights with the airport
 * after them — "[REDACTED] - SGN" — so the number alone is what is matched on,
 * and the gate is read back to say what the site made of it.
 */
export async function chooseFlight(page, flight, { log } = {}) {
  const box = boxUnder(page, 'Flight Number');
  const wanted = String(flight).trim();
  await box.waitFor({ state: 'visible', timeout: FIELD_TIMEOUT_MS });
  await box.fill('');
  await box.type(wanted, { delay: 25 });
  // The list is fetched as the number is typed, and it answers the letters
  // that were in the box when the request went out. Read while one of those
  // is still in flight it holds the answer to a shorter number, or the bare
  // "Other" it shows with nothing to offer — measured on the live site,
  // "AI238" left only "Other" on screen a moment before "[REDACTED]" brought the
  // flight back. So the wait is for the flight itself, not for a list.
  const option = page
    .locator('[role=option]')
    .filter({ hasText: new RegExp(`^${escapeForSearch(wanted)}\\b`, 'i') })
    .first();
  await option.waitFor({ state: 'visible', timeout: FLIGHT_LIST_MS });
  await option.click();
  await page.waitForTimeout(CASCADE_MS);
  const gate = await page
    .locator('input[name="borderGate"]')
    .first()
    .inputValue()
    .catch(() => '');
  log?.(`the flight ${flight} put "${gate.trim()}" in the border gate`);
  return gate.trim();
}

/**
 * Puts the address of the place the traveller is staying on the form.
 *
 * The list under "Accommodation Address" offers one option whatever the
 * province and ward say, and it is "Other". Choosing it draws the field the
 * address actually goes in, so both steps are one act as far as a caller is
 * concerned.
 */
export async function enterAddress(page, address) {
  const box = boxUnder(page, 'Accommodation Address');
  await box.waitFor({ state: 'visible', timeout: FIELD_TIMEOUT_MS });
  await box.click();
  await page.waitForTimeout(CASCADE_MS);
  const other = page
    .locator('[role=option]')
    .filter({ hasText: /^Other/ })
    .first();
  await other.click({ timeout: 10000 });
  await page.waitForTimeout(CASCADE_MS);
  const typed = page
    .locator('input[name="customAccommodationAddress"]')
    .first();
  await typed.waitFor({ state: 'visible', timeout: FIELD_TIMEOUT_MS });
  await typed.fill(String(address));
  return true;
}

/**
 * Ticks one of the radios that stand in a row of boxes.
 *
 * These carry no accessible name at all: their value is empty, they have no
 * aria-label, and the word beside them — "Air", "Hotel" — lives in a sibling
 * element. Asked for by role and name, Playwright finds nothing, so the word
 * is what is looked for and the input beside it is what is ticked.
 *
 * The same three ways in as the gender radios on the first page, and for the
 * same reason: Material UI draws its own circle over a zero-sized input, so
 * where the state lives depends on the control.
 */
export async function tickOneOf(page, name, { timeout = 10000 } = {}) {
  const radio = page
    .locator(
      `xpath=//*[normalize-space(text())=${JSON.stringify(name)}]` +
        `/preceding::input[@type='radio'][1]`
    )
    .first();
  await radio.waitFor({ state: 'attached', timeout });
  // Already the site's own answer: these rows come with one of them chosen,
  // and ticking the one that is ticked would be work for nothing.
  if (await radio.isChecked().catch(() => false)) {
    return name;
  }
  const ways = [
    () => radio.check({ force: true, timeout: 5000 }),
    () =>
      page.getByText(name, { exact: true }).first().click({ timeout: 5000 }),
    () => radio.dispatchEvent('click'),
  ];
  let last = null;
  for (const way of ways) {
    await way().catch((error) => {
      last = error;
    });
    if (await radio.isChecked().catch(() => false)) {
      return name;
    }
  }
  throw new Error(
    `${name} would not tick${last ? `: ${saidBriefly(last)}` : ''}`
  );
}

/**
 * Fills the trip page from what is known about the journey.
 *
 * The order matters in two places and nowhere else: the flight comes before
 * anything that reads the border gate, and the province comes before the ward,
 * which comes before the address. The site draws each of those from the one
 * above it.
 */
export async function fillTrip(page, trip = {}, { log = () => {} } = {}) {
  const filled = [];
  const missing = [];
  const failed = [];

  const put = async (key, what, doing) => {
    if (what === null || what === undefined || what === '') {
      missing.push(key);
      return;
    }
    await doing()
      .then(() => filled.push(key))
      .catch((error) => failed.push(`${key}: ${saidBriefly(error)}`));
  };

  await put('modeOfTravel', trip.modeOfTravel ?? 'Air', () =>
    tickOneOf(page, trip.modeOfTravel ?? 'Air')
  );
  // Before anything that reads the gate: the site fills the gate from this.
  await put('vehicleNumber', trip.vehicleNumber, () =>
    chooseFlight(page, trip.vehicleNumber, { log })
  );
  await put('departedFrom', trip.departedFrom, () =>
    chooseFrom(
      page,
      boxUnder(page, 'Departure country before Arrival in Vietnam'),
      trip.departedFrom,
      'the country flown from'
    )
  );
  await put('purpose', purposeAsNamedHere(trip.purpose), () =>
    chooseFrom(
      page,
      boxUnder(page, 'Purpose of Travel'),
      purposeAsNamedHere(trip.purpose),
      'the purpose'
    )
  );
  await put('accommodationType', stayAsNamedHere(trip.accommodationType), () =>
    tickOneOf(page, stayAsNamedHere(trip.accommodationType))
  );
  // The province draws the ward, and the ward draws the address.
  await put('province', trip.province, () =>
    chooseFrom(
      page,
      boxUnder(page, 'Province / City of Hotel'),
      trip.province,
      'the province'
    ).then(() => page.waitForTimeout(CASCADE_MS))
  );
  await put('ward', trip.ward, () =>
    chooseFrom(
      page,
      boxUnder(page, 'Ward / Commune of Hotel'),
      trip.ward,
      'the ward'
    ).then(() => page.waitForTimeout(CASCADE_MS))
  );
  await put('accommodationAddress', trip.accommodationAddress, () =>
    enterAddress(page, trip.accommodationAddress)
  );
  await put('workplace', trip.workplace, () =>
    page.locator('input[name="workplaceInfo"]').first().fill(trip.workplace)
  );
  await put('departureDate', trip.departureDate, () =>
    fieldUnder(page, 'Expected date of departure from Vietnam').fill(
      trip.departureDate
    )
  );

  log(
    `trip page: ${filled.length} filled, ${missing.length} missing, ` +
      `${failed.length} failed`
  );
  return { filled, missing, failed };
}

/** What the trip page holds now, read back so a fill can be checked. */
export async function readTrip(page) {
  const values = {};
  for (const field of TRIP_FIELDS) {
    if (field.how === 'radio' || field.how === 'stay') {
      continue;
    }
    const box =
      field.how === 'combobox'
        ? boxUnder(page, field.heading)
        : fieldUnder(page, field.heading);
    const value = await box.inputValue().catch(() => null);
    if (value) {
      values[field.key] = value;
    }
  }
  const gate = await page
    .locator('input[name="borderGate"]')
    .first()
    .inputValue()
    .catch(() => null);
  if (gate) {
    values.borderGate = gate;
  }
  const address = await page
    .locator('input[name="customAccommodationAddress"]')
    .first()
    .inputValue()
    .catch(() => null);
  if (address) {
    values.accommodationAddress = address;
  }
  return values;
}
