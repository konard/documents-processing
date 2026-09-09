// evisa-vietnam-address.mjs
//
// The address in Viet Nam, taken off a booking the applicant has already made.
//
// The form asks for it in three parts: the street as typed, and the province
// and ward from dropdowns whose wording is the site's own. A booking gives the
// address in one line, often with the city and country in the applicant's
// language — "25/7 Tran Phu, Vinh Hai Ward, Нячанг, Вьетнам" — so the line
// is taken apart, the city is recognised whichever language names it, and each
// part is written the way the site's dropdown spells it.

/** Cities as a booking may name them, against the site's own spelling. */
const CITIES = [
  {
    province: 'KHANH HOA',
    town: 'NHA TRANG',
    names: ['nha trang', 'нячанг', 'нha trang'],
  },
  {
    province: 'HO CHI MINH City',
    town: 'HO CHI MINH',
    names: ['ho chi minh', 'hochiminh', 'saigon', 'хошимин', 'сайгон'],
  },
  {
    province: 'HA NOI City',
    town: 'HA NOI',
    names: ['ha noi', 'hanoi', 'ханой'],
  },
  {
    province: 'DA NANG City',
    town: 'DA NANG',
    names: ['da nang', 'danang', 'дананг'],
  },
  { province: 'LAM DONG', town: 'DA LAT', names: ['da lat', 'dalat', 'далат'] },
  {
    province: 'KIEN GIANG',
    town: 'PHU QUOC',
    names: ['phu quoc', 'фукуок', 'фу куок'],
  },
  {
    province: 'QUANG NAM',
    town: 'HOI AN',
    names: ['hoi an', 'хойан', 'хой ан'],
  },
  {
    province: 'BA RIA - VUNG TAU',
    town: 'VUNG TAU',
    names: ['vung tau', 'вунгтау', 'вунг тау'],
  },
  { province: 'THUA THIEN HUE', town: 'HUE', names: ['hue', 'хюэ', 'хуэ'] },
  {
    province: 'HAI PHONG City',
    town: 'HAI PHONG',
    names: ['hai phong', 'haiphong', 'хайфон'],
  },
  { province: 'CAN THO City', town: 'CAN THO', names: ['can tho', 'кантхо'] },
  {
    province: 'BINH THUAN',
    town: 'PHAN THIET',
    names: ['phan thiet', 'mui ne', 'фантьет', 'муйне', 'муй не'],
  },
];

/** A name in the site's capitals, written as an address would print it. */
function titleCase(name) {
  return String(name)
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/** Words that name the country, in either language. */
const COUNTRY =
  /^(viet\s*nam|vietnam|вьетнам|socialist republic of viet\s*nam)$/i;

/** How a ward is written on a booking, against how the site spells it. */
const WARD_WORDS = /\b(?:phuong|ward|phường)\b/i;

/** The province the site would call this place, or null. */
export function provinceOf(text) {
  return cityOf(text)?.province ?? null;
}

/** The city a line names, with the province and town the site knows it by. */
export function cityOf(text) {
  const lower = String(text ?? '').toLowerCase();
  return (
    CITIES.find((city) => city.names.some((name) => lower.includes(name))) ??
    null
  );
}

/**
 * The ward's bare name, as the booking wrote it: "Van Thanh Ward" gives
 * "VAN THANH".
 *
 * The site's own list is what the name has to be matched against, and that
 * list changes: Viet Nam merged its wards, so a ward a booking still names
 * may have been absorbed into a larger one. Producing a spelling here and
 * hoping the dropdown holds it puts an unfillable value on the form, so the
 * name is left bare for `matchWard` to place against the real options.
 */
export function wardOf(text) {
  const part = String(text ?? '').trim();
  if (!WARD_WORDS.test(part)) {
    return null;
  }
  const name = part
    .replace(/\b(?:phuong|ward|phường)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return name ? name.toUpperCase() : null;
}

/**
 * The option on the site's list that a ward name belongs to.
 *
 * Matched by name first. When the ward is not listed at all, which happens
 * where wards have been merged, the city it sits in decides: "VAN THANH" is in
 * Nha Trang, and Nha Trang's own ward is what the form will accept.
 */
export function matchWard(name, options = [], city = null) {
  const wanted = String(name ?? '')
    .toUpperCase()
    .replace(/\b(?:PHUONG|WARD)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const bare = (option) =>
    String(option)
      .toUpperCase()
      .replace(/\b(?:PHUONG|WARD)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  if (wanted) {
    const exact = options.find((option) => bare(option) === wanted);
    if (exact) {
      return exact;
    }
  }
  // The city's own ward, which is where a merged ward ended up.
  const town = String(city ?? '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (town) {
    const named = options.filter((option) => bare(option) === town);
    if (named.length) {
      return named[0];
    }
  }
  return null;
}

/**
 * Takes a one-line address off a booking into the three parts the form wants.
 *
 * Returns `{ addressInVietnam, provinceInVietnam, wardInVietnam }`, each null
 * when the line does not say. The street keeps the booking's own wording,
 * since the site takes that box as typed; the country and the city are dropped
 * from it, because the dropdowns beside it already say both.
 */
export function parseVietnamAddress(line) {
  const text = String(line ?? '').trim();
  if (!text) {
    return {
      addressInVietnam: null,
      provinceInVietnam: null,
      wardInVietnam: null,
    };
  }
  const parts = text
    .split(',')
    .map((part) => part.replace(/[•·]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const province = provinceOf(text);
  let ward = null;
  const street = [];
  for (const part of parts) {
    if (COUNTRY.test(part)) {
      continue;
    }
    const asWard = wardOf(part);
    if (asWard && !ward) {
      ward = asWard;
      continue;
    }
    // The city names the province beside it, so it is left out of the street.
    if (provinceOf(part) && !street.length) {
      continue;
    }
    if (provinceOf(part)) {
      continue;
    }
    street.push(part);
  }
  const town = cityOf(text)?.town ?? null;
  // The box asks for the whole temporary address, as the site's own example
  // gives it: street, then ward, then city. A booking writes the last two in
  // whatever language it was displayed in, so they are written back in
  // English from what the site itself calls them.
  const whole = [
    street.join(', '),
    ward ? `${titleCase(ward)} Ward` : null,
    town ? titleCase(town) : null,
  ].filter(Boolean);
  return {
    addressInVietnam: street.length ? whole.join(', ') : null,
    provinceInVietnam: province,
    wardInVietnam: ward,
    townInVietnam: town,
  };
}

/**
 * The line on a page that reads like an address in Viet Nam.
 *
 * A booking screenshot is mostly prices and dates; the address is the line
 * with a street number on it, or the one naming a place the site knows.
 */
export function findVietnamAddress(lines = []) {
  const scored = lines
    .map((line) => String(line ?? '').trim())
    .filter((line) => line.length > 8)
    .map((line) => ({
      line,
      // A place the site knows is the strongest sign; a house number and a
      // ward each add to it.
      score:
        (provinceOf(line) ? 3 : 0) +
        (WARD_WORDS.test(line) ? 2 : 0) +
        (/\d+[/-]?\d*\s+[A-Za-z]/.test(line) ? 2 : 0) +
        (line.includes(',') ? 1 : 0),
    }))
    .filter((candidate) => candidate.score >= 3)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.line ?? null;
}
