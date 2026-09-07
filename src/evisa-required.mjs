// evisa-required.mjs
//
// Asks the live form which fields it requires, so the list cannot go stale.
//
// The site marks a required field by putting `ant-form-item-required` on its
// label. Reading those marks at run time means a change on their side shows up
// as a question to the applicant.

import { FIELDS, RADIO_GROUPS, UPLOADS } from './evisa-schema.mjs';

/**
 * Reads the form and reports which controls it marks as required, and which of
 * those are still empty.
 *
 * Returns entries keyed by our own field names where the control is one we
 * know, so a caller can ask for exactly what is missing. Anything required that
 * we cannot map is reported under `unmapped`, which is the signal that the form
 * has grown a field this tool does not handle yet.
 */
export async function readRequiredFields(page) {
  const byId = {};
  for (const [name, field] of Object.entries(FIELDS)) {
    byId[field.id] = { name, kind: field.kind };
  }
  for (const [name, upload] of Object.entries(UPLOADS)) {
    byId[upload.id] = { name, kind: 'upload' };
  }

  const found = await page.evaluate(() => {
    const out = [];
    for (const label of document.querySelectorAll('.ant-form-item-required')) {
      const item = label.closest('.ant-form-item') ?? label.parentElement;
      const control = item?.querySelector('input, select, textarea');
      const selected = item
        ?.querySelector('.ant-select-selection-item')
        ?.textContent?.trim();
      out.push({
        id: control?.id ?? null,
        type: control?.type ?? null,
        label: (label.textContent ?? '').replace(/\s+/g, ' ').trim(),
        value: selected || control?.value || '',
      });
    }
    return out;
  });

  const required = [];
  const unmapped = [];
  for (const entry of found) {
    const known = entry.id ? byId[entry.id] : undefined;
    if (known) {
      required.push({
        ...known,
        id: entry.id,
        label: entry.label,
        value: entry.value,
      });
    } else {
      unmapped.push(entry);
    }
  }

  return {
    required,
    unmapped,
    missing: required.filter((field) => !field.value),
  };
}

/**
 * Names the fields still needed to submit, given what has been collected.
 *
 * Radio questions default to a safe answer, so they are not chased. A value the
 * applicant has already supplied is left alone even when the form shows it
 * empty, since it may simply not have been filled in yet.
 */
export function outstandingFields(requiredReport, collected = {}, skip = []) {
  const answered = new Set(Object.keys(collected).filter((k) => collected[k]));
  const radios = new Set(Object.keys(RADIO_GROUPS));
  const ignored = new Set(skip);
  return requiredReport.missing
    .filter(
      (field) =>
        !answered.has(field.name) &&
        !radios.has(field.name) &&
        !ignored.has(field.name)
    )
    .map((field) => ({ name: field.name, label: field.label }));
}
