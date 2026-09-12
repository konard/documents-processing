// evisa-captcha-routing.mjs
//
// Which page a captcha code belongs to.
//
// Three pages in this bot ask for one: the visa form's review page, the
// lookup, and the pre-arrival declaration on its own site. A six-digit code
// looks the same on all three and says nothing about where it came from, so
// what settles it is which page the chat has open and waiting.
//
// Getting that wrong types a code into the wrong site, and the site that did
// ask goes on waiting for one that already arrived.

/**
 * Takes a code on the review page as the visa form's captcha, asked for or not.
 *
 * One sent during the countdown replaces the one typed, and the countdown
 * starts over on it. Reports whether it did, so the caller can stop.
 */
export function reviewCaptchaTaker({
  looksLikeCaptcha,
  settleCountdown,
  log,
  typeTheCaptcha,
}) {
  return function tookReviewCaptcha(ctx, chatId, session) {
    if (session.stage !== 'review' || !looksLikeCaptcha(ctx.message.text)) {
      return false;
    }
    if (settleCountdown(chatId, 'stop')) {
      log(chatId, 'another captcha code received during the countdown');
    } else {
      log(chatId, 'captcha code received');
    }
    typeTheCaptcha(ctx, chatId, ctx.message.text).catch((error) =>
      log(chatId, `the captcha step failed: ${error.message}`)
    );
    return true;
  };
}

/**
 * Whichever captcha the chat is waiting on, answered where it belongs.
 *
 * The declaration is asked first: it is opened by a command and closed as
 * soon as it is filled, so a chat holding one is unambiguously waiting on it,
 * while the review page can sit at that stage for as long as the form does.
 */
export function anyCaptchaTaker({ tookArrivalCaptcha, ...forReview }) {
  const tookReviewCaptcha = reviewCaptchaTaker(forReview);
  return async function tookAnyCaptcha(ctx, chatId, session) {
    return (
      (await tookArrivalCaptcha(ctx, chatId)) ||
      tookReviewCaptcha(ctx, chatId, session)
    );
  };
}
