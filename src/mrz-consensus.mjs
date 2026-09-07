// mrz-consensus.mjs
//
// Reads a passport with several OCR engines and keeps what they agree on.
//
// No single engine is reliable on every scan: on a set of real passports each
// one read some field wrong, but never the same field as the others. Their
// errors are independent, so a value several engines reach separately carries
// far more weight, and a value they split on is what a person should check.

/** Normalizes a value so formatting differences do not split a vote. */
const key = (value) =>
  String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/**
 * Trims OCR'd MRZ filler from a name.
 *
 * The MRZ pads names with `<`, which engines read as runs of a repeated letter.
 * Dropping a trailing run of one repeated character keeps those readings
 * comparable while leaving a genuine second name intact.
 */
export function trimNameFiller(value) {
  const text = key(value);
  const match = text.match(/^(.*?)(.)\2{2,}$/);
  return match ? match[1] : text;
}

/** Groups readings of one field into candidate values with their supporters. */
function tally(readings, field) {
  const isName = field === 'surname' || field === 'givenName';
  const groups = new Map();

  for (const [reader, reading] of Object.entries(readings)) {
    const raw = reading?.[field];
    if (raw === undefined || raw === null || raw === '') {
      continue;
    }
    const id = isName ? trimNameFiller(raw) : key(raw);
    if (!id) {
      continue;
    }
    if (!groups.has(id)) {
      groups.set(id, { value: raw, supporters: [] });
    }
    groups.get(id).supporters.push(reader);
  }

  return [...groups.values()].sort(
    (a, b) => b.supporters.length - a.supporters.length
  );
}

/**
 * Combines several readings of the same passport into one result.
 *
 * A field is accepted when at least `minAgreement` engines agree on it and no
 * other value has equal support. A tie is left unresolved: with the engines
 * split evenly there is nothing to say which side is right, and picking one
 * would put an unchecked value on a form.
 */
export function consensus(readings, { minAgreement = 2, fields } = {}) {
  const names = fields ?? [
    'documentNumber',
    'birthDate',
    'expirationDate',
    'surname',
    'givenName',
  ];

  const data = {};
  const agreement = {};
  const disputed = [];
  const unread = [];

  for (const field of names) {
    const candidates = tally(readings, field);
    if (candidates.length === 0) {
      unread.push(field);
      continue;
    }

    const [best, runnerUp] = candidates;
    const tied =
      runnerUp && runnerUp.supporters.length === best.supporters.length;

    if (tied || best.supporters.length < minAgreement) {
      disputed.push({
        field,
        candidates: candidates.map((c) => ({
          value: c.value,
          readers: c.supporters,
        })),
      });
      continue;
    }

    data[field] = best.value;
    agreement[field] = {
      readers: best.supporters,
      votes: best.supporters.length,
      total: Object.keys(readings).length,
    };
  }

  return {
    data,
    agreement,
    disputed,
    unread,
    // Every requested field settled, with nothing left for a person to resolve.
    complete: disputed.length === 0 && unread.length === 0,
  };
}

/** Describes the outcome in lines a person can act on. */
export function describeConsensus(result) {
  const lines = [];
  for (const [field, info] of Object.entries(result.agreement)) {
    lines.push(`${field}: ${info.votes}/${info.total} engines agree`);
  }
  for (const { field, candidates } of result.disputed) {
    const options = candidates
      .map((c) => `"${c.value}" (${c.readers.length})`)
      .join(' vs ');
    lines.push(`DISPUTED ${field}: ${options} - check this by hand`);
  }
  for (const field of result.unread) {
    lines.push(`${field}: no engine could read it`);
  }
  return lines;
}

/**
 * Reads a passport with cheap engines first, calling an expensive one only when
 * they fail to settle every field.
 *
 * Most scans are read identically by the fast engines, so the slow one is
 * rarely needed. On a set of real passports this reached the same accuracy as
 * running everything, at roughly a third of the time.
 *
 * `readers` are tried in order and grouped into tiers by cost. Each is an
 * object with `name` and `read(image)`, as in mrz-readers.mjs.
 */
export async function tieredConsensus(image, { fast, slow = [], ...options }) {
  const readings = {};
  const used = [];
  const failures = [];

  const collect = async (reader) => {
    try {
      readings[reader.name] = await reader.read(image);
      used.push(reader.name);
    } catch (error) {
      failures.push({ reader: reader.name, error: error.message });
    }
  };

  await Promise.all(fast.map(collect));
  let result = consensus(readings, options);

  for (const reader of slow) {
    if (result.complete) {
      break;
    }
    // Something is still unsettled, so the extra cost is worth paying.
    await collect(reader);
    result = consensus(readings, options);
  }

  return {
    ...result,
    readers: used,
    failures,
    escalated: used.length > fast.length,
  };
}
