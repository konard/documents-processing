// evisa-sections.mjs
//
// The form as its own parts, in the order they are printed.
//
// The applicant reads the form downwards, so it is worth filling downwards:
// the photographs, then who they are, then the passport, then the trip. Each
// part is filled, settled and sent before the next is begun, so the chat shows
// the form appearing in the order it is actually being filled.
//
// Which field belongs to which part is read from the page, since the page is
// the only thing that knows. The order below is a fallback for a page that
// cannot be read, and the names are the site's own.

/** The parts of the form, in the order the site prints them. */
export const SECTION_ORDER = [
  "FOREIGNER'S IMAGES",
  '1. PERSONAL INFORMATION',
  '2. REQUESTED INFORMATION',
  '3. PASSPORT INFORMATION',
  '4. CONTACT INFORMATION',
  '5. OCCUPATION',
  '6. INFORMATION ABOUT THE TRIP',
  '7. ACCOMPANY CHILD(REN)',
  "8. TRIP'S EXPENSES, INSURANCE",
];

/**
 * Which part each field sits in, as a fallback.
 *
 * Read off the live form. The page is asked again at fill time, so a form
 * that has been rearranged is still filled in its own order; this is what is
 * used when the page will not say.
 */
export const FIELD_SECTIONS = {
  surname: 1,
  givenName: 1,
  dateOfBirth: 1,
  sex: 1,
  nationality: 1,
  identityCard: 1,
  email: 1,
  confirmEmail: 1,
  religion: 1,
  placeOfBirth: 1,
  dateOfBirthPrecision: 1,
  usedOtherPassportsToVietnam: 1,
  multipleNationalities: 1,
  violatedVietnameseLaw: 1,

  validFrom: 2,
  validTo: 2,
  entryType: 2,

  passportNumber: 3,
  passportIssuingAuthority: 3,
  passportType: 3,
  passportIssueDate: 3,
  passportExpiryDate: 3,
  holdsOtherValidPassports: 3,

  permanentAddress: 4,
  contactAddress: 4,
  phone: 4,
  emergencyName: 4,
  emergencyAddress: 4,
  emergencyPhone: 4,
  emergencyRelationship: 4,

  occupation: 5,
  occupationInfo: 5,
  employerName: 5,
  position: 5,
  employerAddress: 5,
  employerPhone: 5,

  purpose: 6,
  entryDate: 6,
  stayLengthDays: 6,
  phoneInVietnam: 6,
  addressInVietnam: 6,
  provinceInVietnam: 6,
  wardInVietnam: 6,
  // Not a field on the form: the town the address is in, which is what places
  // a ward the site no longer lists. It belongs with the ward, since the two
  // are needed in the same breath — filled apart, the ward has nothing to be
  // placed against and is dropped.
  townInVietnam: 6,
  entryBorderGate: 6,
  exitBorderGate: 6,
  contactsAgencyInVietnam: 6,
  visitedVietnamLastYear: 6,
  hasRelativesInVietnam: 6,

  intendedExpenses: 8,
  hasInsurance: 8,
  expensesCoveredBy: 8,
};

/** The part an upload belongs to: the pictures at the top of the form. */
export const UPLOAD_SECTION = 0;

/**
 * Asks the page which part each field is in.
 *
 * Each field is placed under the last heading above it, which is how the form
 * itself is laid out. A page that will not answer gives nothing, and the
 * fallback above is used.
 */
export function readFieldSections(page, fields) {
  const ids = Object.entries(fields).map(([name, meta]) => [name, meta.id]);
  return page
    .evaluate((pairs) => {
      const headings = [...document.querySelectorAll('h3')]
        .filter((heading) => heading.offsetParent !== null)
        .map((heading) => ({
          top: heading.getBoundingClientRect().top + window.scrollY,
          title: heading.innerText.trim(),
        }))
        .sort((a, b) => a.top - b.top);
      const found = {};
      for (const [name, id] of pairs) {
        const element = document.getElementById(id);
        if (!element) {
          continue;
        }
        const top = element.getBoundingClientRect().top + window.scrollY;
        let under = null;
        for (const heading of headings) {
          if (heading.top <= top) {
            under = heading.title;
          }
        }
        if (under) {
          found[name] = under;
        }
      }
      return found;
    }, ids)
    .catch(() => ({}));
}

/** The number a heading opens with, or null for one that has none. */
export function sectionNumber(title) {
  const match = String(title ?? '').match(/^(\d+)\./);
  return match ? Number(match[1]) : null;
}

/**
 * Groups an applicant's values by the part of the form they go in.
 *
 * Returns the parts in printed order, each with the values that belong to it,
 * so a caller can fill one part at a time. Values the page has no field for
 * are left in a part of their own at the end, where they are attempted last.
 */
export function groupBySection(values, placement = {}) {
  const parts = new Map();
  for (const [name, value] of Object.entries(values)) {
    const named = placement[name];
    const at = named
      ? (sectionNumber(named) ?? UPLOAD_SECTION)
      : (FIELD_SECTIONS[name] ?? 99);
    if (!parts.has(at)) {
      parts.set(at, {});
    }
    parts.get(at)[name] = value;
  }
  return [...parts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([at, fields]) => ({ at, title: SECTION_ORDER[at] ?? null, fields }));
}

/**
 * Sends one part of the form: its name, then its picture.
 *
 * The name goes first as its own message, since Telegram draws a caption
 * under a picture and the applicant needs to know what they are looking at
 * before they look at it.
 */
export async function sendSection({
  ctx,
  chatId,
  part,
  log,
  InputFile,
  name = (title) => title,
}) {
  if (!part.image) {
    return;
  }
  await ctx.reply(name(part.title)).catch(() => {});
  await ctx
    .replyWithPhoto(new InputFile(part.image, 'section.jpg'))
    .catch((error) => log(chatId, `a part did not send: ${error.message}`));
}

/** What Telegram allows in the caption under a file, in characters. */
const CAPTION_LIMIT = 1024;

/**
 * Sends the filled form with everything there is to say about it.
 *
 * One message whenever it fits: the page, and under it what went on it and
 * what to do next. Telegram allows a thousand characters under a file, and a
 * short form fits inside that; a long one does not, and the rest follows as
 * a second message, since a caption past the limit is refused outright and
 * nothing would arrive at all.
 */
export async function sendOutcome({
  ctx,
  chatId,
  result,
  summary,
  caption,
  log,
  InputFile,
  showStatus,
}) {
  // What the applicant reads under the page: the outcome, then the values.
  const whole = [caption, summary].filter(Boolean).join('\n\n');
  // Counted the way Telegram counts it, which is after the markup is parsed.
  const asShown = whole.replace(/<[^>]+>/g, '');
  const fits = asShown.length <= CAPTION_LIMIT;
  const under = fits ? whole : caption;
  const rest = fits ? null : summary;

  const sending = showStatus(ctx, 'upload_document');
  try {
    await Promise.race([
      ctx
        .replyWithDocument(new InputFile(result.screenshot, 'form.png'), {
          caption: under,
          parse_mode: 'HTML',
        })
        .catch((error) =>
          log(chatId, `the page did not send: ${error.message}`)
        ),
      new Promise((resolve) => {
        const late = setTimeout(resolve, 120_000);
        late.unref?.();
      }),
    ]);
  } finally {
    sending();
  }
  if (rest) {
    log(
      chatId,
      `the summary is ${asShown.length} characters, past the ${CAPTION_LIMIT} ` +
        'a caption holds; sent as a second message'
    );
    await ctx
      .reply(rest, { parse_mode: 'HTML' })
      .catch((error) =>
        log(chatId, `the summary did not send: ${error.message}`)
      );
  }
}

/**
 * The form's own section headings, in the applicant's language.
 *
 * The site writes them in English whatever language it is showing, so a
 * Russian conversation was getting English captions on every picture.
 */
export const SECTION_NAMES = {
  ru: {
    "FOREIGNER'S IMAGES": 'Фотографии',
    '1. PERSONAL INFORMATION': '1. Личные данные',
    '2. REQUESTED INFORMATION': '2. О какой визе просите',
    '3. PASSPORT INFORMATION': '3. Паспорт',
    '4. CONTACT INFORMATION': '4. Контакты',
    '5. OCCUPATION': '5. Работа',
    '6. INFORMATION ABOUT THE TRIP': '6. Поездка',
    '7. ACCOMPANY CHILD(REN)': '7. Дети в том же паспорте',
    "8. TRIP'S EXPENSES, INSURANCE": '8. Расходы и страховка',
    'Photos and passport page': 'Фотографии и страница паспорта',
  },
};

/**
 * A heading reduced to what it says, so two spellings of it match.
 *
 * The site writes "Foreigner's images" where the table said
 * "FOREIGNER'S IMAGES", and types the apostrophe of "TRIP’S" as U+2019 while
 * a keyboard writes U+0027. Matched as written, both fell through to English.
 */
function headingKey(title) {
  return String(title ?? '')
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** A section heading as the applicant reads it. */
export function sectionName(title, language) {
  const named = SECTION_NAMES[language];
  if (!named) {
    return title;
  }
  const text = String(title ?? '').trim();
  const wanted = headingKey(text);
  const entries = Object.entries(named);
  const same = entries.find(([key]) => headingKey(key) === wanted);
  if (same) {
    return same[1];
  }
  // A heading the site has reworded, or one cut short, is matched on the
  // number it opens with.
  const numbered = text.match(/^\d+\./);
  if (numbered) {
    const found = entries.find(([key]) => key.startsWith(numbered[0]));
    if (found) {
      return found[1];
    }
  }
  // A heading with no number of its own, worded differently from the table:
  // the images at the top of the form are the only one, and they are what a
  // heading naming a picture is.
  if (/image|photo/i.test(wanted)) {
    return named["FOREIGNER'S IMAGES"] ?? text;
  }
  return text;
}
