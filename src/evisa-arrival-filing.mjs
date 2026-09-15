#!/usr/bin/env node
// evisa-arrival-filing.mjs
//
// The final, separately confirmed declaration action. CAPTCHA remains an
// intermediate checkpoint even here: it never turns an indeterminate result
// into a blind second Submit.

import { holdDeclarationCaptcha } from './evisa-arrival-captcha-stage.mjs';
import { captchaIsUp } from './evisa-prearrival-form.mjs';
import { fileTheDeclaration } from './evisa-prearrival-pages.mjs';

/** Files only the declaration standing on its separately confirmed review. */
export function declarationFiler(deps) {
  const {
    sessions,
    log,
    MESSAGES,
    showStatus = () => () => {},
    fileDeclaration = fileTheDeclaration,
    askCaptcha = () => Promise.resolve(false),
    captchaOnPage = captchaIsUp,
    holdCaptcha = holdDeclarationCaptcha,
    sendFiledResult = ({ ctx: filingContext, strings: filingStrings }) =>
      filingContext.reply(filingStrings.arrivalFiled),
    sendDuplicateResult = ({
      ctx: filingContext,
      strings: filingStrings,
      passportNumber,
    }) => filingContext.reply(filingStrings.arrivalDuplicate(passportNumber)),
  } = deps;
  return async function file(ctx, chatId) {
    const session = sessions.get(chatId);
    const strings = MESSAGES[session.language];
    const held = session.arrival;
    if (!held || held.stage !== 'review') {
      log(chatId, 'asked to file, but no declaration is on its review page');
      await ctx
        .reply(
          held ? strings.arrivalCannotConfirmNow : strings.arrivalNothingToFile
        )
        .catch(() => {});
      return false;
    }
    // Claim the confirmation before the first await, so two messages arriving
    // together can never create two Submit attempts.
    held.stage = 'filing';
    const busy = showStatus(ctx, 'typing');
    try {
      const checkingCaptcha = captchaOnPage(held.page);
      const captcha =
        checkingCaptcha && typeof checkingCaptcha.then === 'function'
          ? await checkingCaptcha
          : checkingCaptcha;
      if (captcha) {
        await pauseForCaptcha({
          ctx,
          chatId,
          held,
          strings,
          log,
          askCaptcha,
          holdCaptcha,
        });
        return false;
      }
      const out = await fileDeclaration(held.page, {
        confirmed: true,
        log: (said) => log(chatId, said),
      });
      if (out.captcha) {
        await pauseForCaptcha({
          ctx,
          chatId,
          held,
          strings,
          log,
          askCaptcha,
          holdCaptcha,
        });
        return false;
      }
      if (out.emailCode) {
        held.stage = 'email-code';
        log(chatId, 'Submit is waiting for the emailed verification code');
        await ctx.reply(strings.arrivalEmailCode).catch(() => {});
        return false;
      }
      if (out.duplicate) {
        held.stage = 'duplicate';
        log(chatId, 'the declaration was refused as a duplicate');
        await sendDuplicateResult({
          ctx,
          chatId,
          page: held.page,
          strings,
          passportNumber: out.passportNumber,
        }).catch((error) =>
          log(chatId, `duplicate result delivery failed: ${error.message}`)
        );
        return false;
      }
      if (out.filed) {
        held.stage = 'filed';
        await sendFiledResult({ ctx, chatId, page: held.page, strings }).catch(
          (error) =>
            log(chatId, `filed result delivery failed: ${error.message}`)
        );
        return true;
      }
      held.stage = 'review';
      const why = [out.why, ...(out.refused ?? [])].filter(Boolean).join('; ');
      await ctx.reply(strings.arrivalNotFiled(why)).catch(() => {});
      return false;
    } catch (error) {
      held.stage = 'filing-unknown';
      log(chatId, `the declaration did not file: ${error.message}`);
      await ctx.reply(strings.arrivalFilingUnknown).catch(() => {});
      return false;
    } finally {
      busy();
    }
  };
}

/** Keeps the final Submit continuation distinct from earlier Next actions. */
function pauseForCaptcha(args) {
  return args.holdCaptcha({ ...args, resumeStage: 'review' });
}
