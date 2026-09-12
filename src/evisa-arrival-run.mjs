// evisa-arrival-run.mjs
//
// Filling the pre-arrival declaration for a chat: the browser, the captcha,
// and the answer that comes back.
//
// This is to the declaration what the fill half of the bot is to the visa
// application, and it keeps the same promise: the bot types, the traveller
// sends. A declaration is a real filing with the immigration department about
// a real person, so the last press belongs to the person it describes.
//
// The site gates every declaration behind a captcha drawn before any field,
// so the work splits in two around it: opening and asking, then filling once
// the code comes back. A chat waiting on a code is held in `arrival`, and the
// text handler gives it there.

import {
  openDeclaration,
  answerCaptcha,
  captchaIsUp,
  chooseNationality,
  fillDeclaration,
  readDeclaration,
  offeredArrivalDates,
} from './evisa-prearrival-form.mjs';
import { buildDeclaration, fullNameOf } from './evisa-prearrival.mjs';

/** What the declaration wants that no document supplies. */
export const ASKED_FOR = [
  'email',
  'phone',
  'departureDate',
  'accommodationType',
  'accommodationAddress',
];

/**
 * The arrival gate the ticket lands at, as the declaration names it.
 *
 * The ticket prints the airport in full — "HO CHI MINH CITY TAN SON NHAT" —
 * so the flight itself answers this one and the chat is never asked.
 */
export function gateFromTicket(ticket = {}) {
  const said = `${ticket.arrivedAt ?? ''} ${ticket.flightTo ?? ''}`.trim();
  if (/tan son nhat|ho chi minh/i.test(said)) {
    return 'Tan Son Nhat Int Airport (Ho Chi Minh City)';
  }
  if (/noi bai|ha noi|hanoi/i.test(said)) {
    return 'Noi Bai Int Airport (Ha Noi)';
  }
  if (/da nang|danang/i.test(said)) {
    return 'Da Nang Int Airport (Da Nang)';
  }
  return null;
}

/**
 * Everything known about the traveller, in the names the declaration uses.
 *
 * The application record, the granted visa and the ticket each supply part of
 * it, and what none of them holds is what the chat is asked for.
 */
export function declarationFor(session = {}) {
  const data = session.data ?? {};
  const applicant = { ...data, fullName: fullNameOf(data) };
  const { values, missing } = buildDeclaration(applicant);
  return { applicant, values, missing };
}

/**
 * Opens the site and asks the chat to read the captcha that gates it.
 *
 * The browser is kept on the session, since the code that comes back has to
 * reach this very page: a second browser would show a different picture.
 */
export async function startDeclaration({
  ctx,
  chatId,
  sessions,
  log,
  askCaptcha,
  MESSAGES,
  headless = true,
  debugPort = 0,
}) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  log(chatId, 'opening the pre-arrival declaration');
  const opened = await openDeclaration({ headless, debugPort });
  session.arrival = { ...opened, stage: 'captcha' };
  if (!(await captchaIsUp(opened.page))) {
    log(chatId, 'the declaration opened with no captcha on it');
    return { asked: false, page: opened.page };
  }
  const asked = await askCaptcha(
    ctx,
    chatId,
    strings.arrivalCaptcha,
    opened.page
  );
  log(
    chatId,
    `declaration captcha ${asked ? 'sent to the chat' : 'not found'}`
  );
  return { asked, page: opened.page };
}

/**
 * Takes a captcha code for the declaration and fills what follows.
 *
 * A wrong code leaves the dialog up with a new picture, which is asked for
 * again; the site gives no other answer.
 */
export async function tookDeclarationCaptcha({
  ctx,
  chatId,
  sessions,
  log,
  code,
  askCaptcha,
  MESSAGES,
  describeFilled,
}) {
  const session = sessions.get(chatId);
  const held = session.arrival;
  if (!held || held.stage !== 'captcha') {
    return false;
  }
  const strings = MESSAGES[session.language];
  const passed = await answerCaptcha(held.page, code);
  if (!passed) {
    log(chatId, 'the declaration captcha was refused; asking again');
    await askCaptcha(ctx, chatId, strings.arrivalCaptchaAgain, held.page);
    return true;
  }
  held.stage = 'form';
  log(chatId, 'the declaration captcha was accepted');
  await fillAndShow({
    ctx,
    chatId,
    sessions,
    log,
    MESSAGES,
    describeFilled,
  });
  return true;
}

/**
 * Fills the declaration and shows the traveller what stands on it.
 *
 * Nothing is pressed at the end: the filled page is the answer, and sending
 * it is the traveller's own act.
 */
export async function fillAndShow({
  ctx,
  chatId,
  sessions,
  log,
  MESSAGES,
  describeFilled,
}) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  const held = session.arrival;
  const { applicant, values } = declarationFor(session);

  await chooseNationality(held.page, applicant.nationality).catch((error) =>
    log(chatId, `the nationality did not take: ${error.message}`)
  );

  const result = await fillDeclaration(held.page, {
    ...values,
    ...applicant,
  });

  if (result.arrival?.tooEarly) {
    const offered = await offeredArrivalDates(held.page);
    log(
      chatId,
      `too early to declare: wanted ${applicant.arrivalDate}, offered ${offered.join(', ')}`
    );
    await ctx.reply(strings.arrivalTooEarly(applicant.arrivalDate, offered));
    return result;
  }

  const onThePage = await readDeclaration(held.page);
  log(
    chatId,
    `declaration filled ${result.filled.length}, missing ${result.missing.length}, failed ${result.failed.length}`
  );
  await ctx.reply(describeFilled(onThePage, result, session.language), {
    parse_mode: 'HTML',
  });
  return result;
}

/**
 * Opens the declaration for a chat, closing any left over from before.
 *
 * Two browsers on this site would show two captchas, and the code that came
 * back would be read against whichever page was found first.
 */
export function declarationOpener(deps) {
  const { sessions, log, MESSAGES } = deps;
  return async function begin(ctx, chatId) {
    await closeDeclaration(sessions.get(chatId));
    try {
      await startDeclaration({ ...deps, ctx, chatId });
    } catch (error) {
      log(chatId, `the declaration did not open: ${error.message}`);
      await ctx
        .reply(MESSAGES[sessions.get(chatId).language].browserGone)
        .catch(() => {});
    }
  };
}

/**
 * Wraps the captcha answer as the text handler wants it: one call that says
 * whether the message was the declaration's, so nothing downstream sees it.
 *
 * A six-digit code means nothing on its own — the visa form asks for one too
 * — so only a chat with a declaration open can claim it.
 */
export function declarationCaptchaTaker(deps) {
  const { sessions, looksLikeCaptcha } = deps;
  return function tookIt(ctx, chatId) {
    if (!sessions.get(chatId).arrival || !looksLikeCaptcha(ctx.message.text)) {
      return false;
    }
    return tookDeclarationCaptcha({
      ...deps,
      ctx,
      chatId,
      code: ctx.message.text,
    });
  };
}

/** Closes a declaration's browser, if one is open for the chat. */
export async function closeDeclaration(session = {}) {
  const held = session.arrival;
  if (!held) {
    return false;
  }
  session.arrival = null;
  await held.browser.close().catch(() => {});
  return true;
}
