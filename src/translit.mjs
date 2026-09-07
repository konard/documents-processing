// translit.mjs
//
// Turns Cyrillic into the Latin letters a Vietnamese e-visa form accepts.
//
// The mapping follows ICAO 9303, which is what a passport's own
// machine-readable zone uses. Matching it means a transliterated name agrees
// with the one printed across the bottom of the document, which is what an
// immigration officer compares against.
//
// ICAO spellings can look unfamiliar: Ю becomes IU, Я becomes IA, Ж becomes ZH.
// Matching the passport is what counts.

/** Cyrillic to Latin, as ICAO 9303 defines it for the machine-readable zone. */
const ICAO_9303 = {
  А: 'A',
  Б: 'B',
  В: 'V',
  Г: 'G',
  Д: 'D',
  Е: 'E',
  Ё: 'E',
  Ж: 'ZH',
  З: 'Z',
  И: 'I',
  Й: 'I',
  К: 'K',
  Л: 'L',
  М: 'M',
  Н: 'N',
  О: 'O',
  П: 'P',
  Р: 'R',
  С: 'S',
  Т: 'T',
  У: 'U',
  Ф: 'F',
  Х: 'KH',
  Ц: 'TS',
  Ч: 'CH',
  Ш: 'SH',
  Щ: 'SHCH',
  Ъ: 'IE',
  Ы: 'Y',
  Ь: '',
  Э: 'E',
  Ю: 'IU',
  Я: 'IA',
  // Ukrainian and Belarusian letters, since those passports carry the same zone.
  Ґ: 'G',
  Є: 'IE',
  І: 'I',
  Ї: 'I',
  Ў: 'U',
};

/**
 * Latin back to Cyrillic, the longer pairs first so "SH" is Ш and not С+Н.
 *
 * The reverse of ICAO 9303 loses what the forward mapping lost (soft signs,
 * Й against И), so the result is a near spelling, not the word: "[REDACTED]"
 * for [REDACTED]. That is enough for a map search that allows a letter or
 * two of difference, which is what it is for.
 */
const LATIN_TO_CYRILLIC = [
  ['SHCH', 'Щ'],
  ['KH', 'Х'],
  ['TS', 'Ц'],
  ['CH', 'Ч'],
  ['SH', 'Ш'],
  ['ZH', 'Ж'],
  ['IU', 'Ю'],
  ['YU', 'Ю'],
  ['IA', 'Я'],
  ['YA', 'Я'],
  ['YO', 'Ё'],
  ['YE', 'Е'],
  ['A', 'А'],
  ['B', 'Б'],
  ['C', 'К'],
  ['D', 'Д'],
  ['E', 'Е'],
  ['F', 'Ф'],
  ['G', 'Г'],
  ['H', 'Х'],
  ['I', 'И'],
  ['J', 'Ж'],
  ['K', 'К'],
  ['L', 'Л'],
  ['M', 'М'],
  ['N', 'Н'],
  ['O', 'О'],
  ['P', 'П'],
  ['Q', 'К'],
  ['R', 'Р'],
  ['S', 'С'],
  ['T', 'Т'],
  ['U', 'У'],
  ['V', 'В'],
  ['W', 'В'],
  ['X', 'КС'],
  ['Y', 'Ы'],
  ['Z', 'З'],
];

/** Spells Latin text in Cyrillic, near enough for a fuzzy search. */
export function toCyrillic(value) {
  let rest = String(value ?? '');
  let out = '';
  while (rest) {
    const pair = LATIN_TO_CYRILLIC.find(([latin]) =>
      rest.toUpperCase().startsWith(latin)
    );
    if (!pair) {
      out += rest[0];
      rest = rest.slice(1);
      continue;
    }
    const [latin, cyrillic] = pair;
    const source = rest.slice(0, latin.length);
    out += source === source.toUpperCase() ? cyrillic : cyrillic.toLowerCase();
    rest = rest.slice(latin.length);
  }
  return out;
}

/** True when the text holds any Cyrillic. */
export function hasCyrillic(value) {
  return /[Ѐ-ӿ]/.test(String(value ?? ''));
}

/**
 * The number of single-character edits that turn one string into another.
 *
 * Used to match a word read by OCR, or typed with a slip, against a short list
 * of the words it could be: a distance of one from a five-letter name is a
 * misread, a distance of three is a different word.
 */
export function editDistance(a, b) {
  const left = [...String(a ?? '')];
  const right = [...String(b ?? '')];
  let previous = right.map((_, index) => index + 1);
  previous.unshift(0);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current.push(
        Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

/**
 * Transliterates Cyrillic to Latin, leaving anything already Latin alone.
 *
 * Mixed text is handled character by character, which matters for a value like
 * `МВД 0093` where only part of it needs converting.
 */
export function transliterate(value) {
  const characters = [...String(value ?? '')];
  let out = '';
  characters.forEach((character, index) => {
    const upper = character.toUpperCase();
    const mapped = ICAO_9303[upper];
    if (mapped === undefined) {
      out += character;
      return;
    }
    // Preserve the case of the original: a lower-case source stays lower-case.
    if (character !== upper) {
      out += mapped.toLowerCase();
      return;
    }
    // A capital that opens a word maps to a capital and lower-case letters, so
    // Химки reads Khimki; a capital among capitals maps to capitals.
    const next = characters[index + 1] ?? '';
    const opensAWord = next !== '' && next !== next.toUpperCase();
    out += opensAWord ? mapped[0] + mapped.slice(1).toLowerCase() : mapped;
  });
  return out;
}

/**
 * Transliterates a value only when it needs it, reporting whether it changed.
 *
 * The caller can then tell the applicant their name was converted, which is
 * worth saying: the spelling on their visa has to match their passport, and a
 * transliteration is a judgement they may want to check.
 */
export function toLatin(value) {
  if (!hasCyrillic(value)) {
    return { value: String(value ?? ''), transliterated: false };
  }
  return { value: transliterate(value), transliterated: true };
}
