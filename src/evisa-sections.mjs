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

/**
 * Sends the filled form with the fill's outcome under it, then the
 * explanation of what went where.
 *
 * The form first: it is what the applicant checks, and the explanation reads
 * against it. It goes as a PDF, paged at the same cuts as the pictures, and
 * as those pictures: Telegram shrinks a photo to fit a screen, and a page
 * nine screens tall comes out too small to read either way. The explanation
 * is its own message because Telegram's caption limit would cut a list of
 * forty values short.
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
  const sending = showStatus(ctx, 'upload_document');
  try {
    // The parts went out as they were filled, so what is left is the whole
    // page, as the file the applicant keeps, with the outcome under it.
    await Promise.race([
      ctx
        .replyWithDocument(new InputFile(result.screenshot, 'form.png'), {
          caption,
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
  if (summary) {
    await ctx
      .reply(summary, { parse_mode: 'HTML' })
      .catch((error) =>
        log(chatId, `the summary did not send: ${error.message}`)
      );
  }
}
