// evisa-geocode.mjs
//
// Checks a home address against a real map.
//
// An address typed into a chat may carry a wrong postal code, a misspelt
// street, or a remark that is not part of it. Looking it up in OpenStreetMap,
// through the Photon service that indexes it, says whether the street and
// house exist where the applicant says they are, and gives the country, city
// and postal code as the map records them. A rendering built from those parts
// is one an officer abroad can check against the same map.
//
// The lookup is best effort: the map can lack a house, and the service can be
// down. Either way the caller falls back to rendering the address as written.

import { addressParts, latinUnit } from './evisa-home-address.mjs';

/** Photon indexes OpenStreetMap and answers without a key. */
export const GEOCODER_URL =
  process.env.EVISA_GEOCODER_URL ?? 'https://photon.komoot.io/api/';

/** How the tool names itself to the service, as its usage terms ask. */
const USER_AGENT =
  'documents-processing-evisa/1.0 (https://github.com/konard/documents-processing)';

/**
 * Looks an address up and reports what the map says.
 *
 * Returns null when nothing matched or the service could not be reached.
 * Otherwise `{ street, houseNumber, city, postalCode, country, countryCode,
 * type, postalCodeMatches }`, with the names in English where the map has
 * them and as recorded otherwise.
 */
export async function lookupAddress(text, { fetchImpl = fetch } = {}) {
  const parts = addressParts(text);
  if (!parts.street.length) {
    return null;
  }
  const features = await fetchFeatures(
    queryUnits(parts.written).join(', '),
    fetchImpl
  );
  // The house the applicant wrote is the first number after the street.
  const written = (parts.street[1] ?? '').match(/^\s*(\d+)/)?.[1] ?? '';
  const hit = pickFeature(features, written);
  return hit ? describeFeature(hit, parts.postalCode, written) : null;
}

/** What the map says about the answer picked, in the terms the caller uses. */
function describeFeature(hit, postalCode, written) {
  const p = hit.properties;
  return {
    street: p.street ?? p.name ?? '',
    houseNumber: p.housenumber ?? '',
    city: p.city ?? p.county ?? p.state ?? '',
    postalCode: p.postcode ?? '',
    country: p.country ?? '',
    countryCode: (p.countrycode ?? '').toUpperCase(),
    type: p.type,
    postalCodeMatches: !postalCode || !p.postcode || postalCode === p.postcode,
    // A house was found, and it is the house asked for: the map's number
    // begins with the applicant's. A different house on the right street is
    // a street-level match, and its postal code may not be the applicant's.
    houseMatches: isHouseNumbered(hit, written),
  };
}

/** The map's answers to a query, or none when it cannot be reached. */
async function fetchFeatures(query, fetchImpl) {
  const url = new URL(GEOCODER_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('limit', '3');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      return [];
    }
    return (await response.json()).features ?? [];
  } catch {
    return [];
  }
}

/** True for a house on the map whose number begins with the one written. */
function isHouseNumbered(feature, written) {
  return (
    feature.properties?.type === 'house' &&
    Boolean(written) &&
    new RegExp(`^${written}(?!\\d)`).test(feature.properties.housenumber ?? '')
  );
}

/**
 * The house asked for is the answer wanted; a street will do when the map
 * has no house numbers there. Anything coarser says nothing about the
 * address.
 */
function pickFeature(features, written) {
  return (
    features.find((feature) => isHouseNumbered(feature, written)) ??
    features.find((feature) =>
      ['house', 'street'].includes(feature.properties?.type)
    ) ??
    null
  );
}

/** Street types written short, and the way the map writes them out. */
const STREET_WORDS = [
  [/^(?:ул|улица)\.?\s+/i, 'улица '],
  [/(?:^|\s)(?:б-р|бул)\.?(?=\s|$)/i, ' бульвар'],
  [/(?:^|\s)(?:пр-т|просп|пр)\.?(?=\s|$)/i, ' проспект'],
  [/(?:^|\s)пер\.?(?=\s|$)/i, ' переулок'],
  [/(?:^|\s)наб\.?(?=\s|$)/i, ' набережная'],
  [/(?:^|\s)ш\.?(?=\s|$)/i, ' шоссе'],
  [/(?:^|\s)пл\.?(?=\s|$)/i, ' площадь'],
  [/(?:^|\s)(?:обл|область)\.?$/i, ' область'],
];

/**
 * The units as the map wants them asked: markers dropped or written out,
 * and the building joined to its house, "94 к3", as the map records it.
 *
 * "улица" before a name that already ends in a type ("Гоголевский бульвар")
 * is dropped, since the map has no such street.
 */
function queryUnits(written) {
  const units = [];
  for (const unit of written) {
    let text = unit.replace(/^(?:г|гор|город)\.?\s+/i, '');
    for (const [pattern, word] of STREET_WORDS) {
      text = text.replace(pattern, word);
    }
    text = text.replace(
      /^улица\s+(.*(?:бульвар|проспект|шоссе|площадь|набережная|переулок))$/i,
      '$1'
    );
    const building = text.match(/^(?:корп|корпус|к)\.?\s*(\d+\w*)$/i);
    if (building && units.length) {
      units[units.length - 1] += ` к${building[1]}`;
      continue;
    }
    if (/^(?:стр|строение|оф|офис|под|подъезд|эт|этаж)\b/i.test(text)) {
      continue;
    }
    units.push(text.trim());
  }
  return units;
}

/**
 * Renders an address from what the map confirmed, keeping the applicant's
 * own building and flat, which the map does not hold.
 *
 * Returns null when the lookup does not confirm the address well enough to
 * build on: no house found, a different house, or a postal code the map
 * contradicts.
 */
export function renderVerifiedAddress(text, found) {
  if (!found || !found.street || !found.houseMatches) {
    return null;
  }
  if (!found.postalCodeMatches) {
    return null;
  }
  const parts = addressParts(text);
  // The street as the map names it, rendered the way a typed one is, and
  // the house as the applicant wrote it, which carries the building the
  // map's own number may fold in or leave out.
  const [, ...afterStreet] = parts.street;
  return [
    found.country || parts.country,
    found.postalCode || parts.postalCode,
    found.city || parts.city,
    latinUnit(found.street),
    ...afterStreet.map((unit) => unit.trim()),
  ]
    .filter(Boolean)
    .join(', ');
}
