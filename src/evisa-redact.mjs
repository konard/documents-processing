// evisa-redact.mjs
//
// Finding personal data and taking it out of the repository's history.
//
// A public repository keeps every version of every file it has ever held.
// A value committed one day and deleted the next is still there, readable
// by anyone who clones it, and there have been several such leaks here: a
// trace file with a passport and an email, addresses in fixtures, a phone
// number in a test.
//
// What this does is replace values, not remove history. Every commit keeps
// its place, its message, its author and its date; every file that ever
// existed still exists. Only the personal strings inside them become
// [REDACTED], so the shape of the work stays readable and reviewable and
// what should never have been published stops being published.
//
// The values themselves are never written down here. They are read from a
// passport at run time, or from a file kept outside the repository, so this
// module can live in the public tree without being the leak it exists to
// mend.

/** What replaces a value, short enough to keep a line's shape. */
export const REDACTED = '[REDACTED]';

/**
 * A value worth redacting: long enough to mean something by itself.
 *
 * A two-letter surname or a one-digit house number matches half the tree
 * and would redact the source itself. Nothing shorter than this is taken
 * from a passport reading without being named explicitly.
 */
const SHORTEST = 4;

/** The fields a passport reading gives that identify a person. */
export const PERSONAL_FIELDS = [
  'surname',
  'givenName',
  'givenNameAsPrinted',
  'passportNumber',
  'dateOfBirth',
  'passportExpiryDate',
  'passportIssueDate',
  'placeOfBirth',
  'passportIssuingAuthority',
  'permanentAddress',
  'contactAddress',
  'emergencyAddress',
  'email',
  'phone',
  'emergencyPhone',
  'emergencyName',
  'applicationNumber',
];

/**
 * The ways a value gets written, so a search for one finds all of them.
 *
 * A phone number appears as 1234567 and as 123-45-67; a date in the order
 * the passport prints it and in the order the site wants; a name in upper
 * case in the machine line and in title case beneath it. Redacting only
 * the spelling the passport gave leaves the others in place.
 */
export function spellingsOf(value) {
  const said = String(value ?? '').trim();
  if (said.length < SHORTEST) {
    return [];
  }
  const spellings = new Set([said]);
  spellings.add(said.toUpperCase());
  spellings.add(said.toLowerCase());
  // A run of digits, however it is grouped or spaced.
  const digits = said.replace(/\D/g, '');
  if (digits.length >= 6) {
    spellings.add(digits);
  }
  // A date in the other orders it gets written in.
  const iso = said.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, year, month, day] = iso;
    spellings.add(`${day}/${month}/${year}`);
    spellings.add(`${day}.${month}.${year}`);
    spellings.add(`${day}-${month}-${year}`);
  }
  const slashed = said.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  if (slashed) {
    const [, day, month, year] = slashed;
    spellings.add(`${year}-${month}-${day}`);
  }
  return [...spellings].filter((one) => one.length >= SHORTEST);
}

/**
 * Every spelling of every personal value in a reading, longest first.
 *
 * Longest first matters: redacting "Sample Street 12" before "Sample Street"
 * leaves no orphaned fragment behind where the longer value was.
 */
export function valuesToRedact(reading = {}, also = []) {
  const found = new Set();
  for (const field of PERSONAL_FIELDS) {
    for (const spelling of spellingsOf(reading[field])) {
      found.add(spelling);
    }
  }
  for (const extra of also) {
    // Named explicitly, so a short one is the caller's choice to make.
    const said = String(extra ?? '').trim();
    if (said) {
      found.add(said);
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

/** A string as a regular expression that matches itself and nothing else. */
export function asPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Takes every given value out of a piece of text.
 *
 * Case is ignored, since the same name is written several ways, and the
 * count says how much was found so a run can be reported honestly.
 */
export function redactText(text, values) {
  let said = String(text ?? '');
  let removed = 0;
  for (const value of values) {
    const pattern = new RegExp(asPattern(value), 'gi');
    said = said.replace(pattern, () => {
      removed += 1;
      return REDACTED;
    });
  }
  return { text: said, removed };
}

/**
 * The replacement file git's own text filter reads.
 *
 * Each line is `literal:VALUE==>[REDACTED]`, which replaces the value
 * wherever it appears in a blob without touching anything else in it.
 */
export function replacementsFile(values) {
  return `${values.map((value) => `literal:${value}==>${REDACTED}`).join('\n')}\n`;
}

/**
 * Whether a path holds something worth searching.
 *
 * A binary file has no readable values to redact, and rewriting one by
 * pattern corrupts it.
 */
export function worthSearching(path) {
  return !/\.(png|jpe?g|gif|pdf|zip|gz|woff2?|ico|mp4|webp)$/i.test(path);
}

/**
 * Turns a glob into the expression that matches a path against it.
 *
 * Only what a path needs: `*` for a run within one segment, `**` for one
 * that crosses segments, `?` for a single character. A pattern with no
 * slash matches the name anywhere in the tree, which is how anyone writing
 * `*.test.js` expects it to read, and a trailing `**` means everything
 * under a directory, which is how `src/**` reads.
 */
export function globToPattern(glob) {
  // Each piece is translated on its own and joined, so a character the
  // translation writes is never read again as one the caller wrote.
  // Splitting on a capture leaves empty strings around each match, so what
  // counts as last is the last piece that says anything.
  const pieces = glob.split(/(\*\*\/|\*\*|\*|\?)/);
  const ends = pieces.reduce((last, piece, at) => (piece ? at : last), 0);
  const body = pieces
    .map((piece, at) => {
      if (piece === '**/') {
        return '(?:.*/)?';
      }
      if (piece === '**') {
        // At the end it stands for the whole of what follows, files and
        // directories alike; in the middle it is any run of directories.
        return at === ends ? '.*' : '(?:.*/)?';
      }
      if (piece === '*') {
        return '[^/]*';
      }
      if (piece === '?') {
        return '[^/]';
      }
      return piece.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(glob.includes('/') ? `^${body}$` : `(^|/)${body}$`);
}

/**
 * Which files a run is allowed to change.
 *
 * A tool that rewrites every commit needs a way to be told where to look and
 * where to leave alone. Some files hold a value as a person's data and must
 * be redacted; others hold the same word as a public place name, a nickname
 * or a transliteration case, and redacting those breaks what the file is
 * for. The decision belongs to whoever knows which is which.
 *
 * `only` narrows a run to what matches it; `except` takes files back out.
 * A file must be worth searching either way, since that is about what the
 * bytes are, not about what anyone wants.
 */
export function chooseFiles({ only = [], except = [] } = {}) {
  const wanted = only.map(globToPattern);
  const unwanted = except.map(globToPattern);
  return function chosen(path) {
    if (!worthSearching(path)) {
      return false;
    }
    if (wanted.length && !wanted.some((one) => one.test(path))) {
      return false;
    }
    return !unwanted.some((one) => one.test(path));
  };
}
