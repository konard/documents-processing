// evisa-arrival-captcha-stage.mjs
//
// A CAPTCHA can cover any transition in the pre-arrival declaration, not
// only the first screen. Keep it as its own checkpoint: send only the small
// code image, remember what action it interrupted, and never photograph the
// covered form as though it were the next page.

/** Hands an unexpected declaration CAPTCHA to the traveller and pauses. */
export async function holdDeclarationCaptcha({
  ctx,
  chatId,
  held,
  strings,
  log,
  askCaptcha,
  resumeStage,
}) {
  held.resumeStage = resumeStage;
  held.stage = 'captcha';
  log(chatId, `CAPTCHA interrupted declaration ${resumeStage}; pausing there`);
  const asked = await askCaptcha(
    ctx,
    chatId,
    strings.arrivalCaptchaContinue ?? strings.arrivalCaptcha,
    held.page
  );
  if (asked) {
    return true;
  }

  // No image was available to send. Restore the page checkpoint so "next"
  // can try the gate again after the site's CAPTCHA service recovers.
  held.stage = resumeStage;
  delete held.resumeStage;
  await ctx.reply(strings.arrivalCaptchaUnavailable).catch(() => {});
  return false;
}

/** Takes and clears the page checkpoint a CAPTCHA interrupted. */
export function takeCaptchaResumeStage(held = {}) {
  const stage = held.resumeStage ?? null;
  delete held.resumeStage;
  return stage;
}
