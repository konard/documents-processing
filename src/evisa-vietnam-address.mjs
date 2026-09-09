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
  { province: 'KHANH HOA', names: ['nha trang', 'нячанг', 'нha trang'] },
  {
    province: 'HO CHI MINH City',
    names: ['ho chi minh', 'hochiminh', 'saigon', 'хошимин', 'сайгон'],
  },
  { province: 'HA NOI City', names: ['ha noi', 'hanoi', 'ханой'] },
  { province: 'DA NANG City', names: ['da nang', 'danang', 'дананг'] },
  { province: 'LAM DONG', names: ['da lat', 'dalat', 'далат'] },
  { province: 'KIEN GIANG', names: ['phu quoc', 'фукуок', 'фу куок'] },
  { province: 'QUANG NAM', names: ['hoi an', 'хойан', 'хой ан'] },
  { province: 'BA RIA - VUNG TAU', names: ['vung tau', 'вунгтау', 'вунг тау'] },
  { province: 'THUA THIEN HUE', names: ['hue', 'хюэ', 'хуэ'] },
  { province: 'HAI PHONG City', names: ['hai phong', 'haiphong', 'хайфон'] },
  { province: 'CAN THO City', names: ['can tho', 'кантхо'] },
  {
    province: 'BINH THUAN',
    names: ['phan thiet', 'mui ne', 'фантьет', 'муйне', 'муй не'],
  },
];

/** Words that name the country, in either language. */
const COUNTRY =
  /^(viet\s*nam|vietnam|вьетнам|socialist republic of viet\s*nam)$/i;

/** How a ward is written on a booking, against how the site spells it. */
const WARD_WORDS = /\b(?:phuong|ward|phường)\b/i;

/** The province the site would call this place, or null. */
export function provinceOf(text) {
  const lower = String(text ?? '').toLowerCase();
  for (const city of CITIES) {
    if (city.names.some((name) => lower.includes(name))) {
      return city.province;
    }
  }
  return null;
}

/**
 * The ward as the site spells it: "Vinh Hai Ward" becomes "PHUONG VINH HAI".
 *
 * The site lists every ward that way, and its dropdown matches on the text, so
 * a ward written the booking's way would never be found.
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
  return name ? `PHUONG ${name.toUpperCase()}` : null;
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
  return {
    addressInVietnam: street.length ? street.join(', ') : null,
    provinceInVietnam: province,
    wardInVietnam: ward,
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
