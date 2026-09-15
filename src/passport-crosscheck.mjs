// passport-crosscheck.mjs
//
// A passport data page carries the same facts twice: once printed in the
// visual inspection zone, and once encoded in the machine-readable zone. The
// two are produced independently, so agreement between them is real evidence
// that a value was read correctly, and disagreement pinpoints which field to
// look at by hand.
//
// This matters because a check digit alone is not enough. A misread that
// happens to satisfy the checksum passes silently, and several wrong candidates
// can satisfy it at once, so a repair guided only by the check digit can turn a
// wrong date into a differently wrong date.

/** Fields that appear in both zones and can therefore be cross-checked. */
export const SHARED_FIELDS = [
  'surname',
  'givenName',
  'passportNumber',
  'dateOfBirth',
  'sex',
];

/** Fields only the printed zone carries; the MRZ has no equivalent. */
export const PRINTED_ONLY_FIELDS = [
  'placeOfBirth',
  'passportIssueDate',
  'passportIssuingAuthority',
  'patronymic',
];

const squash = (value) =>
  String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/** Compares two readings of one field, tolerating spacing and punctuation. */
export function valuesAgree(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) {
    return null;
  }
  const left = squash(a);
  const right = squash(b);
  if (!left || !right) {
    return null;
  }
  return left === right;
}

/**
 * Combines a machine-readable and a printed reading of the same passport.
 *
 * A field is `confirmed` only when both zones agree. A conflict is never
 * resolved automatically and the field is left empty: a check digit proves a
 * field is internally consistent, not that its glyphs were read correctly, so
 * neither zone can be declared the winner. The caller is told which field to
 * check by hand.
 */
/** Compares one field across both zones and records the outcome. */
function compareField(field, mrz, printed, out) {
  const fromMrz = mrz[field];
  const fromPrinted = printed[field];
  const agreement = valuesAgree(fromMrz, fromPrinted);

  if (agreement === true) {
    // Both zones agree, so either value will do.
    out.data[field] = fromMrz;
    out.confirmed.push(field);
    return;
  }
  if (agreement === false) {
    // The two zones disagree and nothing here can say which is right: a check
    // digit only proves internal consistency, not that the glyphs were read
    // correctly. Report the conflict and leave the field empty, so the
    // decision belongs to a person.
    out.conflicting.push({ field, mrz: fromMrz, printed: fromPrinted });
    return;
  }

  const only = fromMrz ?? fromPrinted;
  if (only !== undefined && only !== null && only !== '') {
    out.data[field] = only;
    out.singleSource.push(field);
  }
}

export function crossCheck(mrz = {}, printed = {}) {
  const out = {
    data: {},
    confirmed: [],
    conflicting: [],
    singleSource: [],
  };
  const { data, confirmed, conflicting, singleSource } = out;

  for (const field of SHARED_FIELDS) {
    compareField(field, mrz, printed, out);
  }

  for (const field of PRINTED_ONLY_FIELDS) {
    if (printed[field]) {
      data[field] = printed[field];
      singleSource.push(field);
    }
  }

  // Carry over anything the MRZ alone provides, such as nationality or expiry.
  // A disputed field is skipped: it was left out deliberately above, and
  // restoring it here would reintroduce the value the conflict rejected.
  const disputed = new Set(conflicting.map((c) => c.field));
  for (const [field, value] of Object.entries(mrz)) {
    if (data[field] === undefined && value && !disputed.has(field)) {
      data[field] = value;
      if (!singleSource.includes(field)) {
        singleSource.push(field);
      }
    }
  }

  return {
    data,
    confirmed,
    conflicting,
    singleSource,
    // Trustworthy only when nothing disagrees and every shared field was seen
    // in both zones.
    fullyConfirmed:
      conflicting.length === 0 &&
      SHARED_FIELDS.every(
        (f) => confirmed.includes(f) || data[f] === undefined
      ),
  };
}

/**
 * Renders the outcome as lines a person can act on, naming each field that
 * needs checking and what the two zones said.
 */
export function describeCrossCheck(result) {
  const lines = [];
  for (const field of result.confirmed) {
    lines.push(`confirmed by both zones: ${field}`);
  }
  for (const { field, mrz, printed } of result.conflicting) {
    lines.push(
      `CONFLICT in ${field}: machine-readable says "${mrz}", printed says "${printed}" - check this by hand`
    );
  }
  for (const field of result.singleSource) {
    lines.push(`read from one zone only, unconfirmed: ${field}`);
  }
  return lines;
}
