// evisa-address.mjs
//
// Splits an address written the way a map or a booking gives it into the three
// parts the form asks for: street, province/city, and ward/commune.
//
// A pasted address reads outward from the building — house number, street,
// ward, district, city, country — and often carries a district and the city in
// the writer's own language. The form wants the street on its own, and the
// place names spelled the way its dropdowns spell them.
//
// The form has no district field. Vietnam merged its wards and abolished
// district-level administration in 2025, so a district in a pasted address is
// historical: it locates the ward, then it is dropped. `DISTRICT_WARDS` records
// that mapping for the cases where a district name alone is what was given.

import { transliterate } from './translit.mjs';

/**
 * City names as people write them, against the form's own spelling.
 *
 * Cyrillic is transliterated before this lookup, so `Хошимин` arrives as
 * `Khoshimin` and is matched here; a Russian booking confirmation is a common
 * source of an address.
 */
const CITY_ALIASES = {
  'ho chi minh': 'HO CHI MINH City',
  'ho chi minh city': 'HO CHI MINH City',
  hcmc: 'HO CHI MINH City',
  saigon: 'HO CHI MINH City',
  'sai gon': 'HO CHI MINH City',
  khoshimin: 'HO CHI MINH City',
  'thanh pho ho chi minh': 'HO CHI MINH City',
  hanoi: 'HA NOI City',
  'ha noi': 'HA NOI City',
  khanoi: 'HA NOI City',
  'da nang': 'DA NANG City',
  danang: 'DA NANG City',
  'hai phong': 'HAI PHONG City',
  'can tho': 'CAN THO City',
};

/**
 * Former districts against the ward that now covers them.
 *
 * Only entries whose whole area went to one ward belong here. A district split
 * across several wards cannot be resolved from its name alone, and guessing one
 * would put an applicant at an address they never gave.
 */
const DISTRICT_WARDS = {
  'tan binh': 'PHUONG TAN BINH',
};

/** Country names, in the languages an address is likely to arrive in. */
const COUNTRIES = new Set([
  'vietnam',
  'viet nam',
  'vn',
  'vetnam',
  'vietnama',
  'vietname',
]);

/** Strips accents, so `Tân Bình` and `Tan Binh` compare equal. */
const plain = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Reduces a place name to the part that identifies it.
 *
 * `Tan Binh District`, `Quan Tan Binh` and `Tan Binh` all name one place; the
 * words around it say only what kind of place it is.
 */
const core = (value) =>
  plain(value)
    .replace(/\b(thanh pho|tp|tinh|quan|huyen|phuong|xa|tt|thi tran)\b/g, ' ')
    .replace(/\b(city|province|district|ward|commune|town)\b/g, ' ')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** True when a part names a country, which the form has no field for. */
const isCountry = (part) => COUNTRIES.has(plain(transliterate(part)));

/**
 * Recognises a ward, which the form spells `PHUONG <name>` or `XA <name>`.
 *
 * Matching is on the name alone, so `Phường 13`, `Ward 13` and `13` all reach
 * the same candidate.
 */
function matchWard(part, wardOptions) {
  const wanted = core(part);
  if (!wanted) {
    return null;
  }
  const exact = wardOptions.filter((option) => core(option) === wanted);
  // Only an unambiguous match is used: two wards of the same name mean the
  // address does not say which, and picking one would invent an answer.
  return exact.length === 1 ? exact[0] : null;
}

/**
 * Finds the ward that replaced a former district named in the address.
 *
 * Only a part that says it is a district counts: a bare name that matched no
 * ward was ambiguous, and resolving it here would go behind the check that
 * just declined it.
 */
function wardFromDistrict(parts, wardOptions) {
  for (const [index, part] of parts.entries()) {
    if (!/\b(district|quan|huyen)\b/.test(plain(part))) {
      continue;
    }
    const ward = DISTRICT_WARDS[core(part)];
    // With no list to check against, the mapping is still the best answer
    // available; the page rejects a ward it does not offer either way.
    if (ward && (!wardOptions.length || wardOptions.includes(ward))) {
      return {
        ward,
        index,
        note: `"${part}" is a former district; the form now lists it as ${ward}.`,
      };
    }
  }
  return null;
}

/**
 * Splits an address into the fields the form asks for.
 *
 * `wardOptions` are the ward names read from the page, because the list depends
 * on the province and changes when Vietnam redraws its boundaries. Without them
 * the street and city are still resolved and the ward is left to the caller.
 *
 * Returns the three field values along with what could not be placed, so a
 * caller can tell an applicant which part of their address went unused.
 */
export function parseVietnamAddress(address, { wardOptions = [] } = {}) {
  const text = String(address ?? '').trim();
  const result = {
    addressInVietnam: '',
    provinceInVietnam: '',
    wardInVietnam: '',
    unmatched: [],
    notes: [],
  };
  if (!text) {
    return result;
  }

  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  const remaining = [];
  for (const part of parts) {
    if (isCountry(part)) {
      continue;
    }
    // A city is transliterated first, so a Russian rendering matches.
    const city = CITY_ALIASES[core(transliterate(part))];
    if (city && !result.provinceInVietnam) {
      result.provinceInVietnam = city;
      continue;
    }
    remaining.push(part);
  }

  // The street is the first part: an address reads outward from the building.
  if (remaining.length) {
    result.addressInVietnam = remaining.shift();
  }

  // Everything after the street names an administrative area. The ward is
  // whichever of them the page offers, which is what makes a stale district in
  // the middle of an address harmless.
  const leftover = [];
  for (const part of remaining) {
    if (!result.wardInVietnam) {
      const ward = matchWard(part, wardOptions);
      if (ward) {
        result.wardInVietnam = ward;
        continue;
      }
    }
    leftover.push(part);
  }

  if (!result.wardInVietnam) {
    const fromDistrict = wardFromDistrict(leftover, wardOptions);
    if (fromDistrict) {
      result.wardInVietnam = fromDistrict.ward;
      result.notes.push(fromDistrict.note);
      leftover.splice(fromDistrict.index, 1);
    }
  }

  // A part naming the area already resolved is not unused, it is repeated: an
  // address that says both "Tan Binh District" and "Tan Binh" gave one place
  // twice, and reporting it as dropped would suggest something went missing.
  const placed = [result.wardInVietnam, result.provinceInVietnam]
    .filter(Boolean)
    .map(core);
  result.unmatched = leftover.filter((part) => !placed.includes(core(part)));
  return result;
}

/**
 * The address used when an applicant gives none.
 *
 * The form requires all three, and an applicant who has not booked yet still
 * has to put something down.
 */
export const DEFAULT_ADDRESS =
  '406/14 Cong Hoa, Tan Binh District, Tan Binh, Ho Chi Minh City, Vietnam';
