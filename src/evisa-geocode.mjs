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

import {
  addressParts,
  latinUnit,
  canonicalAddress,
  mapQuery,
  mapStreet,
  sameStreet,
} from './evisa-home-address.mjs';

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
  if (!parts.street) {
    return null;
  }
  // The house the applicant wrote, without its letter: "18A" is house 18.
  const written = parts.house.match(/^\d+/)?.[0] ?? '';
  // The map ranks its answers by its own lights, and a house it holds may
  // come behind the street or not at all for one phrasing of the query, so
  // other phrasings are tried until one brings the house of that number on
  // the street asked for: the house joined to the street's own unit, and the
  // street without its type word.
  const query = mapQuery(parts);
  const phrasings = [
    query,
    query.replace(/,\s*([^,]+)$/, ' $1'),
    query.replace(
      /\s*(?:улица|бульвар|проспект|переулок|набережная|шоссе|площадь)(?=,|$)/giu,
      ''
    ),
  ].filter((phrasing, index, all) => all.indexOf(phrasing) === index);
  const wanted = (feature) =>
    isHouseNumbered(feature, written) &&
    sameStreet(mapStreet(parts), feature.properties.street ?? '');
  let features = [];
  let hit = null;
  for (const phrasing of phrasings) {
    features = [...features, ...(await fetchFeatures(phrasing, fetchImpl))];
    hit = features.find(wanted) ?? null;
    if (hit) {
      break;
    }
  }
  hit ??= pickFeature(features, written);
  return hit ? describeFeature(hit, parts, written) : null;
}

/** What the map says about the answer picked, in the terms the caller uses. */
function describeFeature(hit, parts, written) {
  const named = namedOnMap(hit.properties);
  return {
    ...named,
    type: hit.properties.type,
    flat: parts.flat,
    postalCodeMatches:
      !parts.postalCode ||
      !named.postalCode ||
      parts.postalCode === named.postalCode,
    // A house was found, and it is the house asked for: the map's number
    // begins with the applicant's, on a street of the same name. A fuzzy
    // search answers with some house of that number when it cannot find the
    // street, and a different house on the right street is a street-level
    // match whose postal code may not be the applicant's.
    houseMatches:
      isHouseNumbered(hit, written) &&
      sameStreet(mapStreet(parts), named.street),
    cityMatches: cityAgrees(parts, named.city),
  };
}

/** The names the map gives a place, with a blank for each it lacks. */
function namedOnMap(p) {
  return {
    // The map's own identity for the house, which is how two addresses are
    // told to be the same place whatever way each was written.
    osmId: `${p.osm_type ?? ''}${p.osm_id ?? ''}`,
    street: p.street ?? p.name ?? '',
    houseNumber: p.housenumber ?? '',
    city: p.city ?? p.county ?? p.state ?? '',
    postalCode: p.postcode ?? '',
    country: p.country ?? '',
    countryCode: (p.countrycode ?? '').toUpperCase(),
  };
}

/** True unless the applicant named a city and the map names another. */
function cityAgrees(parts, city) {
  if (!parts.city || !city) {
    return true;
  }
  return (
    city.toLowerCase() === parts.city.toLowerCase() ||
    sameStreet(city, parts.written.city)
  );
}

/**
 * True when two lookups name the same flat of the same house on the map,
 * which is what makes two addresses one address however each was written.
 */
export function sameAddress(a, b) {
  return Boolean(
    a?.houseMatches &&
    b?.houseMatches &&
    a.osmId &&
    a.osmId === b.osmId &&
    (a.flat ?? '') === (b.flat ?? '')
  );
}

/** The map's answers to a query, or none when it cannot be reached. */
async function fetchFeatures(query, fetchImpl) {
  const url = new URL(GEOCODER_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('limit', '5');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) {
      return [];
    }
    return (await response.json()).features ?? [];
  } catch {
    return [];
  } finally {
    // Cleared on every path, so a failed request leaves no timer behind.
    clearTimeout(timer);
  }
}

/** True for a house on the map whose number begins with the one written. */
function isHouseNumbered(feature, written) {
  if (feature?.properties?.type !== 'house' || !written) {
    return false;
  }
  const number = String(feature.properties.housenumber ?? '');
  return (
    number.startsWith(written) && !/^\d/.test(number.slice(written.length))
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
  if (!found.postalCodeMatches || !found.cityMatches) {
    return null;
  }
  const parts = addressParts(text);
  // The street as the map names it, rendered the way a typed one is, and
  // the house, building and flat as the applicant wrote them, which the map
  // does not hold in full.
  return canonicalAddress(parts, {
    country: found.country || parts.country,
    postalCode: found.postalCode || parts.postalCode,
    city: found.city || parts.city,
    street: latinUnit(found.street),
  });
}

/**
 * Checks one of an applicant's addresses against the map, and writes back
 * the confirmed rendering when the map knows it.
 *
 * An address the map confirms goes on the form in the map's own words, which
 * the site is more likely to accept than a hand-typed line. One the map does
 * not know is left as the applicant wrote it: their address is theirs, and a
 * map that has not heard of a building is not evidence that it is wrong.
 *
 * The addresses already checked are kept, so two that resolve to the same
 * place can be noted as the same.
 */
export async function verifyAddress(
  chatId,
  session,
  field,
  { log, shown = (value) => value }
) {
  const written = session.data[field];
  const found = await lookupAddress(written);
  session.resolved ??= {};
  session.resolved[field] = found;
  const verified = renderVerifiedAddress(written, found);
  if (verified) {
    log(chatId, `${field} confirmed by the map: ${shown(verified)}`);
    session.data[field] = verified;
    for (const [other, resolved] of Object.entries(session.resolved)) {
      if (other !== field && sameAddress(found, resolved)) {
        log(chatId, `${field} is the same address as ${other}`);
      }
    }
    return;
  }
  const nearest = found
    ? `; nearest on the map: ${shown(`${found.street} ${found.houseNumber}, ${found.postalCode}`)}`
    : '';
  log(chatId, `${field} not confirmed by the map${nearest}`);
}
