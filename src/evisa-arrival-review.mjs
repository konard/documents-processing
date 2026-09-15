#!/usr/bin/env node
// evisa-arrival-review.mjs
//
// The review is photographed with its mandatory declaration already ticked.
// Submit remains a separate action that only a later chat message can cause.

/** Ticks the mandatory Review checkbox while leaving Submit untouched. */
export async function confirmDeclarationReview(page) {
  const box = page.getByRole('checkbox').first();
  const visible =
    typeof box.waitFor === 'function'
      ? await box
          .waitFor({ state: 'visible', timeout: 10000 })
          .then(() => true)
          .catch(() => false)
      : await box.isVisible().catch(() => false);
  if (!visible) {
    return false;
  }
  if (!(await box.isChecked().catch(() => false))) {
    const checked = await box
      .check({ force: true, timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (!checked) {
      await page
        .getByText(/I confirm that the information is correct/i)
        .first()
        .click({ timeout: 10000 })
        .catch(() => {});
    }
  }
  return await box.isChecked().catch(() => false);
}
