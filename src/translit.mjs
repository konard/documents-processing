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

/** True when the text holds any Cyrillic. */
export function hasCyrillic(value) {
  return /[Ѐ-ӿ]/.test(String(value ?? ''));
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
