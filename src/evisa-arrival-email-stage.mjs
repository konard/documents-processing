#!/usr/bin/env node
// evisa-arrival-email-stage.mjs
//
// Submit can stop at a six-digit code sent to the traveller's email. Keep
// that gate distinct from CAPTCHA: both look like short codes in Telegram,
// but they are entered into different dialogs and resume different actions.

import { holdDeclarationCaptcha } from './evisa-arrival-captcha-stage.mjs';
import { verifyDeclarationEmail } from './evisa-prearrival-pages.mjs';

/** Email verification uses exactly six decimal digits. */
export function looksLikeDeclarationEmailCode(text) {
  return /^\d{6}$/.test(String(text ?? '').trim());
}

/** Takes the emailed code only while the declaration is waiting for it. */
export function declarationEmailCodeTaker(deps) {
  const {
    sessions,
    log,
    MESSAGES,
    showStatus = () => () => {},
    verifyEmail = verifyDeclarationEmail,
    askCaptcha = () => Promise.resolve(false),
    holdCaptcha = holdDeclarationCaptcha,
    sendFiledResult = ({ ctx: filingContext, strings: filingStrings }) =>
      filingContext.reply(filingStrings.arrivalFiled),
  } = deps;
  return async function tookEmailCode(ctx, chatId) {
    const session = sessions.get(chatId);
    const held = session.arrival;
    if (
      !held ||
      held.stage !== 'email-code' ||
      !looksLikeDeclarationEmailCode(ctx.message?.text)
    ) {
      return false;
    }

    held.stage = 'verifying-email';
    const strings = MESSAGES[session.language];
    const busy = showStatus(ctx, 'typing');
    try {
      const result = await verifyEmail(held.page, ctx.message.text.trim());
      if (result.captcha) {
        await holdCaptcha({
          ctx,
          chatId,
          held,
          strings,
          log,
          askCaptcha,
          resumeStage: 'email-code',
        });
        return true;
      }
      if (result.filed) {
        held.stage = 'filed';
        log(chatId, 'the email code was accepted; declaration filed');
        await sendFiledResult({ ctx, chatId, page: held.page, strings }).catch(
          (error) =>
            log(chatId, `filed result delivery failed: ${error.message}`)
        );
        return true;
      }
      if (result.emailCode) {
        held.stage = 'email-code';
        log(chatId, `the email code was refused: ${result.why}`);
        await ctx.reply(strings.arrivalEmailCodeAgain).catch(() => {});
        return true;
      }

      held.stage = 'filing-unknown';
      log(chatId, `email verification result is unknown: ${result.why}`);
      await ctx.reply(strings.arrivalEmailVerificationUnknown).catch(() => {});
      return true;
    } catch (error) {
      held.stage = 'filing-unknown';
      log(chatId, `email verification failed: ${error.message}`);
      await ctx.reply(strings.arrivalEmailVerificationUnknown).catch(() => {});
      return true;
    } finally {
      busy();
    }
  };
}
