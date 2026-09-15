#!/usr/bin/env node
// evisa-arrival-declaration.mjs
//
// Adapts the saved traveller record to the pre-arrival site's exact rules.

import { buildDeclaration, fullNameOf } from './evisa-prearrival.mjs';

/** An optional rehearsal date that never changes the saved traveller record. */
export function arrivalDateOverride(env = process.env) {
  const said = String(env.EVISA_ARRIVAL_DATE_OVERRIDE ?? '').trim();
  return /^\d{2}\/\d{2}\/\d{4}$/.test(said) ? said : null;
}

/** Everything known about the traveller, in the declaration's spelling. */
export function declarationFor(session = {}, { log, chatId } = {}) {
  const { data, corrections: nameCorrections } = namesForDeclaration(
    session.data
  );
  const applicant = { ...data, fullName: fullNameOf(data) };
  const { values, missing } = buildDeclaration(applicant);
  const rehearsal = arrivalDateOverride();
  if (rehearsal) {
    log?.(
      chatId,
      `REHEARSAL: arrival date forced to ${rehearsal} (the record says ` +
        `${values.arrivalDate ?? 'nothing'}); this declaration is not filed`
    );
    values.arrivalDate = rehearsal;
    applicant.arrivalDate = rehearsal;
  }
  if (nameCorrections.length) {
    log?.(
      chatId,
      `declaration names adjusted for the site: ${nameCorrections
        .map(({ key, from, to }) => `${key} ${from} -> ${to}`)
        .join('; ')}`
    );
  }
  return { applicant, values, missing, rehearsal, nameCorrections };
}

/** Keeps source names exact while replacing characters this site rejects. */
function namesForDeclaration(source = {}) {
  const data = { ...source };
  const corrections = [];
  for (const key of ['surname', 'givenName']) {
    if (!data[key]) {
      continue;
    }
    const from = String(data[key]).trim();
    const to = from
      .replace(/[-\u2010-\u2015\u2212]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (from !== to) {
      data[key] = to;
      corrections.push({ key, from, to });
    }
  }
  return { data, corrections };
}
