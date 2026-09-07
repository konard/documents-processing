// evisa-home-address.mjs
//
// Recognizes a home address written the Russian way and renders it in Latin
// letters an officer abroad can read.
//
// A Russian address runs from the largest unit to the smallest: country, city,
// postal code, street, house, building, flat. Each unit carries a marker (г.,
// ул., д., корп., кв.) that means nothing once transliterated: "g. Moskva,
// d. 94, kv. 389" reads as noise to anyone who does not know the convention.
// The markers are therefore translated or dropped, the country and the best
// known cities get their English names, and the rest is transliterated the way
// the passport's own machine-readable zone would spell it.

import {
  transliterate,
  toCyrillic,
  hasCyrillic,
  editDistance,
} from './translit.mjs';

/** Country names as they appear at the head of an address. */
const COUNTRIES = {
  россия: 'Russian Federation',
  'российская федерация': 'Russian Federation',
  рф: 'Russian Federation',
  беларусь: 'Belarus',
  белоруссия: 'Belarus',
  украина: 'Ukraine',
  казахстан: 'Kazakhstan',
  узбекистан: 'Uzbekistan',
  кыргызстан: 'Kyrgyzstan',
  киргизия: 'Kyrgyzstan',
  армения: 'Armenia',
  грузия: 'Georgia',
  молдова: 'Moldova',
};

/**
 * Cities whose English names are established and differ from a letter by
 * letter transliteration. Anything else is transliterated, which for most
 * Russian cities gives the usual English spelling.
 */
const CITIES = {
  москва: 'Moscow',
  'санкт-петербург': 'Saint Petersburg',
  спб: 'Saint Petersburg',
  'нижний новгород': 'Nizhny Novgorod',
  екатеринбург: 'Yekaterinburg',
  ростов: 'Rostov-on-Don',
  'ростов-на-дону': 'Rostov-on-Don',
  севастополь: 'Sevastopol',
  ярославль: 'Yaroslavl',
  минск: 'Minsk',
  киев: 'Kyiv',
  алматы: 'Almaty',
  астана: 'Astana',
  ташкент: 'Tashkent',
  бишкек: 'Bishkek',
  ереван: 'Yerevan',
  тбилиси: 'Tbilisi',
  кишинёв: 'Chisinau',
  кишинев: 'Chisinau',
};

/**
 * Markers that open a unit of the address. A `null` rendering drops the
 * marker and keeps what follows, which is what an English address does with a
 * house number or a city name.
 *
 * A marker is only a marker when a dot or a space separates it from the rest:
 * "г. Москва" carries one, "Гагарина 5" does not.
 */
const MARKERS = [
  [/^(?:г|гор|город)(?:\.\s*|\s+)/i, null],
  [/^(?:обл|область)(?:\.\s*|\s+)/i, null],
  [/^(?:р-н|район)(?:\.\s*|\s+)/i, null],
  [
    /^(?:пос|посёлок|поселок|п|с|село|дер|деревня|д)(?:\.\s*|\s+)(?=\p{L})/iu,
    null,
  ],
  [/^(?:д|дом)\.?\s*(?=\d)/i, null],
  [/^(?:корп|корпус|к)\.?\s*(?=\d)/i, 'bld. '],
  [/^(?:стр|строение)\.?\s*(?=\d)/i, 'bldg. '],
  [/^(?:кв|квартира)\.?\s*(?=\d)/i, 'apt. '],
  [/^(?:оф|офис)\.?\s*(?=\d)/i, 'office '],
  [/^(?:под|подъезд)\.?\s*(?=\d)/i, 'entrance '],
  [/^(?:эт|этаж)\.?\s*(?=\d)/i, 'floor '],
];

/** Markers that close a unit: "Московская обл." or "Кировский р-н". */
const TRAILING = [
  [/\s+(?:обл|область)\.?$/i, ' oblast'],
  [/\s+(?:р-н|район)\.?$/i, ' district'],
  [/\s+(?:г|гор|город)\.?$/i, ''],
];

/** Street types, so "ул." and "улица" read the same way. */
const STREET_TYPES = [
  [/^(?:ул|улица)(?:\.\s*|\s+)/i, 'ul. '],
  [/\s+(?:ул|улица)\.?$/i, ' ul.'],
  [/^(?:пр-т|просп|проспект|пр)(?:\.\s*|\s+)/i, 'prospekt '],
  [/\s+(?:пр-т|просп|проспект|пр)\.?$/i, ' prospekt'],
  [/^(?:пер|переулок)(?:\.\s*|\s+)/i, 'pereulok '],
  [/\s+(?:пер|переулок)\.?$/i, ' pereulok'],
  [/^(?:б-р|бул|бульвар)(?:\.\s*|\s+)/i, 'bulvar '],
  [/\s+(?:б-р|бул|бульвар)\.?$/i, ' bulvar'],
  [/^(?:наб|набережная)(?:\.\s*|\s+)/i, 'naberezhnaya '],
  [/\s+(?:наб|набережная)\.?$/i, ' naberezhnaya'],
  [/^(?:ш|шоссе)(?:\.\s*|\s+)/i, 'shosse '],
  [/\s+(?:ш|шоссе)\.?$/i, ' shosse'],
  [/^(?:пл|площадь)(?:\.\s*|\s+)/i, 'ploshchad '],
  [/\s+(?:пл|площадь)\.?$/i, ' ploshchad'],
  [/^(?:мкр|мкрн|микрорайон)(?:\.\s*|\s+)/i, 'mikroraion '],
];

/**
 * Words that mark a line as an address. A phone number or a name carries none
 * of these; a postal address can hardly avoid them.
 *
 * `\b` knows only Latin letters, so the boundaries are spelled out.
 */
const ADDRESS_WORDS =
  /(?<!\p{L})(?:(?:г|ул|д|кв|корп|стр|пр|пер|наб|пл|обл|мкр|оф)\.|улица|шоссе|проспект|переулок|бульвар|набережная|площадь|область|район|город|дом|квартира|корпус|строение|street|avenue|road|lane|apt|apartment|flat|house)(?!\p{L})/giu;

/** A Russian postal code is six digits and sits in the address on its own. */
const POSTAL_CODE = /(?:^|[\s,])\d{6}(?=$|[\s,])/;

/** Labels people put in front of an address, in either language. */
const LABELS =
  /^\s*(?:(?:мой|наш|домашний|постоянный|контактный)\s+)?(?:адрес(?:\s+(?:регистрации|прописки|проживания))?|прописка|регистрация|permanent\s+address|home\s+address|contact\s+address|address)\s*[:\-–—]\s*/i;

/** Strips a leading "Адрес:" or "Permanent address:" from a line. */
export function stripAddressLabel(text) {
  return String(text ?? '')
    .replace(LABELS, '')
    .trim();
}

/**
 * Strips the remark people add after an address: "- адрес для всех троих",
 * "(прописка)". A remark follows a dash or sits in brackets and carries no
 * digit, which no part of an address after the country can say.
 */
export function stripAddressNote(text) {
  return String(text ?? '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+[-–—]\s+[^\d]*$/, '')
    .trim();
}

/**
 * Markers that begin a new unit even without a comma before them.
 *
 * People write "г. Москва ул. Ленина д. 5 кв. 7" and mean four units. A
 * marker for a place or a street opens a unit when a name follows it, one
 * for a house, building or flat when a number does. A street type after
 * its name ("Ленинградское ш. 12") is not split off, since the number
 * belongs to the street, not to the marker.
 */
const INLINE_PLACE =
  /(\S)\s+(?=(?:г|гор|город|пос|посёлок|поселок|обл|область|р-н|район|мкр|ул|улица|пр-т|просп|проспект|пер|переулок|б-р|бульвар|наб|набережная|ш|шоссе|пл|площадь|д|дер|деревня)\.?\s*\p{Lu})/gu;
const INLINE_HOUSE =
  /(\S)\s+(?=(?:д|дом|кв|квартира|корп|корпус|к|стр|строение|оф|офис|под|подъезд|эт|этаж)\.?\s*\d)/giu;

/** Puts a comma before each unit written without one. */
function separateUnits(text) {
  return text.replace(INLINE_PLACE, '$1, ').replace(INLINE_HOUSE, '$1, ');
}

/**
 * True when a line reads as a postal address.
 *
 * Two independent signs are wanted, since a single "д." can appear in prose:
 * a postal code and one marker, or two markers. An English address may carry
 * one word such as "Street" alone, so a line of three or more parts holding a
 * number counts as well.
 */
export function looksLikeAddress(text) {
  const line = stripAddressLabel(text);
  const markers = (line.match(ADDRESS_WORDS) ?? []).length;
  const code = POSTAL_CODE.test(line) ? 1 : 0;
  if (markers + code >= 2) {
    return true;
  }
  const parts = line.split(',').filter((part) => part.trim()).length;
  return markers >= 1 && parts >= 3 && /\d/.test(line);
}

/** Renders one unit of an address, a street name most usefully, in Latin. */
export function latinUnit(unit) {
  return renderUnit(unit);
}

/** Renders one comma-separated unit of the address. */
function renderUnit(unit) {
  let text = unit.trim();
  if (!text) {
    return '';
  }

  for (const [pattern, rendering] of MARKERS) {
    const match = text.match(pattern);
    if (match) {
      text = (rendering ?? '') + text.slice(match[0].length);
      break;
    }
  }
  for (const [pattern, rendering] of TRAILING) {
    text = text.replace(pattern, rendering);
  }

  const key = text.toLowerCase().replace(/\s+/g, ' ');
  if (COUNTRIES[key]) {
    return COUNTRIES[key];
  }
  if (CITIES[key]) {
    return CITIES[key];
  }

  // "ул. Гоголевский б-р" names its type twice; the one at the end is the
  // street's own, and the map knows the street by it.
  text = text.replace(
    /^(?:ул|улица)\.?\s+(?=.*\s(?:б-р|бул|бульвар|пр-т|просп|проспект|пр|пер|переулок|наб|набережная|ш|шоссе|пл|площадь)\.?$)/i,
    ''
  );
  for (const [pattern, rendering] of STREET_TYPES) {
    text = text.replace(pattern, rendering);
  }
  return transliterate(text);
}

/**
 * Renders a home address in Latin letters, in the one order the form gets:
 * country, postal code, region, city, street, house, building, flat.
 *
 * A Russian address is put into that order however the applicant wrote it,
 * and an address typed in Latin letters for a Russian house is too, so the
 * permanent and the emergency address of two people in one flat read alike.
 * An address from elsewhere keeps its own order, since a British or an
 * Indian address has one of its own, and gets only its case and country
 * spelling settled.
 */
export function latinAddress(value) {
  const parts = addressParts(value);
  if (parts.ordered && parts.street) {
    return canonicalAddress(parts);
  }
  return normalizeLatinAddress(
    parts.units
      .map((unit) => renderUnit(unit))
      .filter(Boolean)
      .join(', ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The address as the form gets it, from its parts, with any part the map
 * confirmed put in place of the applicant's own.
 */
export function canonicalAddress(parts, confirmed = {}) {
  const building = parts.building ? `bld. ${parts.building}` : '';
  const flat = parts.flat ? `apt. ${parts.flat}` : '';
  return normalizeLatinAddress(
    [
      confirmed.country ?? parts.country,
      confirmed.postalCode ?? parts.postalCode,
      ...parts.regions,
      confirmed.city ?? parts.city,
      confirmed.street ?? parts.street,
      parts.house,
      building,
      flat,
      ...parts.rest,
    ]
      .filter(Boolean)
      .join(', ')
  );
}

/**
 * Words that stay in lower case inside an address: the markers and street
 * types, and the joiners inside a name such as Rostov-on-Don.
 */
const LOWER_WORDS = new Set([
  'apt',
  'apartment',
  'flat',
  'bld',
  'bldg',
  'building',
  'korpus',
  'block',
  'floor',
  'office',
  'entrance',
  'room',
  'house',
  'ul',
  'ulitsa',
  'bulvar',
  'prospekt',
  'pereulok',
  'shosse',
  'naberezhnaya',
  'ploshchad',
  'mikroraion',
  'oblast',
  'district',
  'region',
  'kv',
  'dom',
  'of',
  'on',
  'na',
  'de',
  'la',
  'le',
  'du',
  'and',
  'the',
]);

/** The joiners among the lower-case words, which sit inside names only. */
const JOINERS = new Set([
  'of',
  'on',
  'na',
  'de',
  'la',
  'le',
  'du',
  'and',
  'the',
]);

/** Short forms that are written in capitals wherever they appear. */
const ACRONYMS = new Set(['UK', 'USA', 'UAE', 'USSR', 'RF', 'DC', 'NY']);

/**
 * The one spelling for each country, whatever the applicant wrote: the
 * passport says "Russian Federation", and every address should say the same.
 */
const COUNTRY_SPELLINGS = {
  russia: 'Russian Federation',
  'russian federation': 'Russian Federation',
  'the russian federation': 'Russian Federation',
  rf: 'Russian Federation',
  'united states': 'United States of America',
  'united states of america': 'United States of America',
  usa: 'United States of America',
  'united kingdom': 'United Kingdom',
  uk: 'United Kingdom',
  'great britain': 'United Kingdom',
};

/** One word of an address in the case it should carry. */
function caseWord(word, first) {
  const match = word.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
  const [, before, core, after] = match;
  if (!core) {
    return word;
  }
  let cased;
  if (/^\d/.test(core)) {
    cased = core.toUpperCase();
  } else if (
    LOWER_WORDS.has(core.toLowerCase()) &&
    (!first || !JOINERS.has(core.toLowerCase()))
  ) {
    // A marker is lower case wherever it stands ("apartment 16"); a joiner
    // is lower case only inside a name, since "of" may open nothing.
    cased = core.toLowerCase();
  } else if (ACRONYMS.has(core.toUpperCase())) {
    cased = core.toUpperCase();
  } else {
    cased = core
      .split('-')
      .map((part, index) =>
        index > 0 && LOWER_WORDS.has(part.toLowerCase())
          ? part.toLowerCase()
          : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
      )
      .join('-');
  }
  return before + cased + after;
}

/**
 * Brings an address in Latin letters to one way of writing: names in
 * capitals-first case, markers and street types in lower case, house
 * letters in capitals, and the country by its one spelling. Someone typing
 * in capitals, someone typing in lower case, and the rendering of a Russian
 * address then all read alike on the form.
 */
export function normalizeLatinAddress(text) {
  return String(text ?? '')
    .split(',')
    .map((unit) => unit.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .map((unit) => {
      const spelling = COUNTRY_SPELLINGS[unit.toLowerCase()];
      if (spelling) {
        return spelling;
      }
      return unit
        .split(' ')
        .map((word, index) => caseWord(word, index === 0))
        .join(' ');
    })
    .join(', ');
}

/** The unit patterns an address is taken apart by, in either language. */
const FLAT_UNIT = /^(?:кв|квартира|apt|apartment|flat|room)\.?\s*(\S+)$/i;
const BUILDING_UNIT =
  /^(?:корп|корпус|к|bld|bldg|building|korpus|block)\.?\s*(\S+)$/i;
const HOUSE_UNIT = /^(?:(?:д|дом|house)\.?\s*)?(\d+\S*)$/i;
const POSTAL_UNIT = /^\d{6}$/;
const REGION_UNIT =
  /(?:^|\s)(?:обл|область|р-н|район|край|oblast|district|region|krai)\.?$/i;
const STREET_TYPED =
  /(?:^|\s)(?:ул|улица|пр-т|просп|проспект|пр|пер|переулок|б-р|бул|бульвар|наб|набережная|ш|шоссе|пл|площадь|мкр|street|st|avenue|ave|road|rd|lane|ul|ulitsa|bulvar|prospekt|pereulok|shosse|naberezhnaya|ploshchad)\.?(?:\s|$)/i;
const STREET_WITH_HOUSE = /^(.*\p{L}.*?)\s+(\d+\S*)$/u;

/** The one spelling of a country the applicant may have written either way. */
function canonicalCountry(unit) {
  const key = unit.toLowerCase().replace(/\s+/g, ' ').trim();
  return COUNTRIES[key] ?? COUNTRY_SPELLINGS[key] ?? null;
}

/**
 * Takes a home address apart into what each unit is: the country, the
 * postal code, the regions, the city, the street, the house, the building,
 * the flat, and whatever is left over. Each is rendered in Latin letters;
 * the words as written are kept beside them for the map lookup.
 *
 * `ordered` says whether the address belongs to a country whose addresses
 * the form gets in the canonical order: one written in Cyrillic, or one
 * naming a country of the region.
 */
export function addressParts(value) {
  const text = separateUnits(stripAddressNote(stripAddressLabel(value)));
  const units = text
    .split(',')
    .map((unit) => unit.trim())
    .filter(Boolean);
  const parts = {
    country: '',
    postalCode: '',
    regions: [],
    city: '',
    street: '',
    house: '',
    building: '',
    flat: '',
    rest: [],
    written: { city: '', street: '', regions: [] },
    units,
    ordered: hasCyrillic(text),
  };
  for (const unit of units) {
    placeUnit(parts, unit);
  }
  parts.ordered ||= Object.values(COUNTRIES).includes(parts.country);
  return parts;
}

/** Puts one unit of an address where it belongs among the parts. */
function placeUnit(parts, unit) {
  const country = canonicalCountry(unit);
  if (country) {
    parts.country = country;
  } else if (POSTAL_UNIT.test(unit)) {
    parts.postalCode = unit;
  } else if (!placeNumberedUnit(parts, unit)) {
    placeNamedUnit(parts, unit);
  }
}

/** Places a flat, a building or a house number; false when the unit is none. */
function placeNumberedUnit(parts, unit) {
  let match;
  if ((match = unit.match(FLAT_UNIT))) {
    parts.flat = match[1];
  } else if ((match = unit.match(BUILDING_UNIT))) {
    parts.building = match[1];
  } else if (!parts.house && (match = unit.match(HOUSE_UNIT))) {
    parts.house = transliterate(match[1]).toUpperCase();
  } else {
    return false;
  }
  return true;
}

/** Places a region, a city, a street, or what is left over. */
function placeNamedUnit(parts, unit) {
  const marked = /^(?:г|гор|город)\.?\s+/i.test(unit);
  let match;
  if (REGION_UNIT.test(unit) && !STREET_TYPED.test(unit)) {
    parts.regions.push(renderUnit(unit));
    parts.written.regions.push(unit);
  } else if (marked || (!parts.city && !parts.street && !/\d/.test(unit))) {
    parts.city = renderUnit(unit);
    parts.written.city = unit.replace(/^(?:г|гор|город)\.?\s+/i, '');
  } else if (!parts.street && (match = unit.match(STREET_WITH_HOUSE))) {
    parts.street = renderUnit(match[1]);
    parts.written.street = match[1];
    parts.house = transliterate(match[2]).toUpperCase();
  } else if (!parts.street) {
    parts.street = renderUnit(unit);
    parts.written.street = unit;
  } else {
    parts.rest.push(renderUnit(unit));
  }
}

/** Street types written short, and the way the map writes them out. */
const MAP_STREET_WORDS = [
  [/^(?:ул|улица|ul|ulitsa|street|st)\.?\s+/i, 'улица '],
  [/(?:^|\s)(?:ул|улица|ul|ulitsa|street|st)\.?$/i, ' улица'],
  [/(?:^|\s)(?:б-р|бул|бульвар|bulvar|boulevard)\.?(?=\s|$)/i, ' бульвар'],
  [
    /(?:^|\s)(?:пр-т|просп|пр|проспект|prospekt|avenue|ave)\.?(?=\s|$)/i,
    ' проспект',
  ],
  [/(?:^|\s)(?:пер|переулок|pereulok)\.?(?=\s|$)/i, ' переулок'],
  [/(?:^|\s)(?:наб|набережная|naberezhnaya)\.?(?=\s|$)/i, ' набережная'],
  [/(?:^|\s)(?:ш|шоссе|shosse)\.?(?=\s|$)/i, ' шоссе'],
  [/(?:^|\s)(?:пл|площадь|ploshchad)\.?(?=\s|$)/i, ' площадь'],
];

/** The Russian name of a city the dictionary gives an English name. */
function nativeCity(city) {
  const key = String(city ?? '').toLowerCase();
  const native = Object.entries(CITIES).find(
    ([, english]) => english.toLowerCase() === key
  )?.[0];
  return native ? native.charAt(0).toUpperCase() + native.slice(1) : null;
}

/**
 * The address as a map of the region is asked for it: in Cyrillic, with the
 * street type written out and the building joined to its house, "94 к3".
 *
 * A street typed in Latin letters is spelled back into Cyrillic, near enough
 * for the map's fuzzy matching to find it; that is how the Latin form of an
 * address is shown to name the same house as the Russian one. "улица" before
 * a name that already ends in a type ("Гоголевский бульвар") is dropped,
 * since the map has no such street. An address from elsewhere is asked for
 * as written.
 */
export function mapQuery(parts) {
  if (!parts.ordered) {
    return parts.units.filter((unit) => !FLAT_UNIT.test(unit)).join(', ');
  }
  const countryKey = Object.entries(COUNTRIES).find(
    ([, name]) => name === parts.country
  )?.[0];
  const country = countryKey
    ? countryKey.charAt(0).toUpperCase() + countryKey.slice(1)
    : '';
  const written = parts.written.city || parts.city;
  const city = nativeCity(written) ?? toCyrillic(written);
  const house = parts.house
    ? toCyrillic(parts.house) + (parts.building ? ` к${parts.building}` : '')
    : '';
  return [
    country,
    parts.postalCode,
    ...parts.written.regions.map(toCyrillic),
    city,
    mapStreet(parts),
    house,
  ]
    .filter(Boolean)
    .join(', ');
}

/** The street as the map is asked for it: in Cyrillic, its type written out. */
export function mapStreet(parts) {
  if (!parts.ordered) {
    return parts.written.street;
  }
  let street = parts.written.street;
  for (const [pattern, word] of MAP_STREET_WORDS) {
    street = street.replace(pattern, word);
  }
  return toCyrillic(
    street
      .replace(/\s+/g, ' ')
      .trim()
      .replace(
        /^улица\s+(.*(?:бульвар|проспект|шоссе|площадь|набережная|переулок))$/i,
        '$1'
      )
  );
}

/** Words that name a street's type, not the street itself. */
const TYPE_WORDS = new Set([
  'улица',
  'бульвар',
  'проспект',
  'переулок',
  'набережная',
  'шоссе',
  'площадь',
  'street',
  'avenue',
  'road',
  'lane',
  'boulevard',
  'ul',
  'bulvar',
  'prospekt',
  'pereulok',
  'shosse',
]);

/**
 * True when two street names are the same street, allowing for the letters
 * a spelling back from Latin loses: every name word of the shorter has a
 * word within two edits in the other, type words aside.
 */
export function sameStreet(a, b) {
  const words = (text) =>
    String(text ?? '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word && !TYPE_WORDS.has(word));
  const [shorter, longer] = [words(a), words(b)].sort(
    (x, y) => x.length - y.length
  );
  if (!shorter.length) {
    return false;
  }
  return shorter.every((word) =>
    longer.some(
      (other) =>
        editDistance(word, other) <=
        (Math.min(word.length, other.length) >= 5 ? 2 : 0)
    )
  );
}

/** Countries a passport names as a birthplace, in the applicant's language. */
const BIRTH_COUNTRIES = {
  ...COUNTRIES,
  ссср: 'USSR',
  индия: 'India',
  германия: 'Germany',
  вьетнам: 'Vietnam',
  таиланд: 'Thailand',
  турция: 'Turkey',
  китай: 'China',
};

/** A single word in title case: MOSKVA reads as Moskva. */
function titleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Renders a place of birth as a passport prints it, "Г.МОСКВА/USSR", in a
 * form an officer abroad reads: "Moscow, USSR".
 *
 * The native half names the city or the country; the best known cities get
 * their English names, a city one misread letter away from one is taken as
 * it, and the rest is transliterated. The Latin half is kept, and two halves
 * naming the same country give it a single time. The whole is then written
 * the way an address is, so "RUSSIA" and "Russia" read alike.
 */
/**
 * True for a city or country the dictionaries know, in Russian, allowing one
 * misread letter in a name of five or more.
 */
export function isKnownPlace(name) {
  const key = String(name ?? '')
    .toLowerCase()
    .replace(/^(?:г|гор|город)\.?\s*/, '')
    .trim();
  if (CITIES[key] || BIRTH_COUNTRIES[key]) {
    return true;
  }
  return Object.keys({ ...CITIES, ...BIRTH_COUNTRIES }).some(
    (known) => known.length >= 5 && editDistance(known, key) <= 1
  );
}

export function latinPlaceOfBirth(value) {
  const text = String(value ?? '').trim();
  if (!hasCyrillic(text)) {
    return normalizeLatinAddress(text);
  }
  const halves = text
    .split('/')
    .map((half) => half.trim())
    .filter(Boolean);
  const rendered = [];
  for (const half of halves) {
    if (!hasCyrillic(half)) {
      rendered.push(half);
      continue;
    }
    const name = half
      .replace(/^(?:г|гор|город)\.?\s*/i, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const known =
      CITIES[name] ??
      BIRTH_COUNTRIES[name] ??
      Object.entries({ ...CITIES, ...BIRTH_COUNTRIES }).find(
        ([key]) => key.length >= 5 && editDistance(key, name) <= 1
      )?.[1];
    rendered.push(
      known ?? transliterate(name).split(' ').map(titleCase).join(' ')
    );
  }
  const unique = rendered.filter(
    (part, index) =>
      rendered.findIndex(
        (other) => other.toLowerCase() === part.toLowerCase()
      ) === index
  );
  return normalizeLatinAddress(unique.join(', '));
}
