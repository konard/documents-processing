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

import { transliterate, hasCyrillic } from './translit.mjs';

/** Country names as they appear at the head of an address. */
const COUNTRIES = {
  россия: 'Russia',
  'российская федерация': 'Russia',
  рф: 'Russia',
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
  [/^(?:пос|посёлок|поселок|п|с|село|дер|деревня|д)(?:\.\s*|\s+)(?=\D)/i, null],
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

  for (const [pattern, rendering] of STREET_TYPES) {
    text = text.replace(pattern, rendering);
  }
  return transliterate(text);
}

/**
 * Renders a home address in Latin letters.
 *
 * The order is left as written, since the applicant's own ordering is the one
 * their post arrives by. Anything already in Latin letters passes through
 * untouched, so an English address is not altered.
 */
export function latinAddress(value) {
  const text = stripAddressLabel(value);
  if (!hasCyrillic(text)) {
    return text;
  }
  return text
    .split(',')
    .map(renderUnit)
    .filter(Boolean)
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim();
}
