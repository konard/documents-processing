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
  readCaptchaImage,
  refreshCaptchaImage,
  readCaptchaText,
} from './evisa-prearrival-form.mjs';
import { buildDeclaration, fullNameOf } from './evisa-prearrival.mjs';

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
 * An arrival date to use in place of the traveller's own, for a rehearsal.
 *
 * `EVISA_ARRIVAL_DATE_OVERRIDE=14/09/2026` makes the bot fill the form for a
 * day the site is willing to offer, so every other field can be watched going
 * in against the real record. A flight three days out cannot be declared yet,
 * and waiting until it can is a poor moment to discover a field the site
 * refuses.
 *
 * It is a rehearsal and nothing more. The declaration is never sent — the
 * last press belongs to the traveller either way — so the date on the screen
 * is a date nobody files. It must be taken out before the real filing, and
 * the bot says so in the log every time it is used.
 */
export function arrivalDateOverride(env = process.env) {
  const said = String(env.EVISA_ARRIVAL_DATE_OVERRIDE ?? '').trim();
  return /^\d{2}\/\d{2}\/\d{4}$/.test(said) ? said : null;
}

/**
 * Everything known about the traveller, in the names the declaration uses.
 *
 * The application record, the granted visa and the ticket each supply part of
 * it, and what none of them holds is what the chat is asked for.
 */
export function declarationFor(session = {}, { log, chatId } = {}) {
  const data = session.data ?? {};
  const applicant = { ...data, fullName: fullNameOf(data) };
  const { values, missing } = buildDeclaration(applicant);
  const rehearsal = arrivalDateOverride();
  if (rehearsal) {
    // Said every time, and loudly: a rehearsal that is mistaken for the real
    // filing is worse than no rehearsal, because the traveller believes their
    // declaration is in.
    log?.(
      chatId,
      `REHEARSAL: arrival date forced to ${rehearsal} (the record says ` +
        `${values.arrivalDate ?? 'nothing'}); this declaration is not filed`
    );
    values.arrivalDate = rehearsal;
    applicant.arrivalDate = rehearsal;
  }
  return { applicant, values, missing, rehearsal };
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
  describeFilled,
  ocr = null,
  tries = 6,
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

  // Reading it is free to get wrong: a refused code only draws another
  // picture. So the bot tries for itself first, and the traveller is asked
  // only for the pictures it cannot read.
  if (ocr) {
    const solved = await solveCaptcha({
      page: opened.page,
      chatId,
      log,
      ocr,
      tries,
    });
    if (solved) {
      session.arrival.stage = 'form';
      await fillAndShow({
        ctx,
        chatId,
        sessions,
        log,
        MESSAGES,
        describeFilled,
      });
      return { asked: false, solved: true, page: opened.page };
    }
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
 * How many of the readings must agree before a code is worth submitting.
 *
 * Measured against the live site: accepted codes carried most of the votes,
 * refused ones two to four. Below this a fresh picture is the better move.
 */
export const CONFIDENT_VOTES = 6;

/**
 * Reads the captcha and tries it, for as many pictures as it takes.
 *
 * Each refusal draws a fresh picture, and the pictures differ in how legible
 * they are, so trying again is worth more than trying harder at one of them.
 */
export async function solveCaptcha({ page, chatId, log, ocr, tries = 6 }) {
  const { renderImage, withImageFile, ...rest } = ocr;
  for (let round = 1; round <= tries; round += 1) {
    const bytes =
      round === 1
        ? await readCaptchaImage(page)
        : await refreshCaptchaImage(page);
    if (!bytes) {
      log(chatId, 'no captcha picture to read');
      return false;
    }
    const img = await withImageFile(bytes, (file) => renderImage(file));
    const { code, agreed } = readCaptchaText(img, { renderImage, ...rest });
    if (!code) {
      log(chatId, `captcha ${round}: nothing readable`);
      continue;
    }
    // How many readings agreed says how likely the code is right: every code
    // the site accepted had most of them behind it, and every one it refused
    // had a handful. A picture this hard to read is cheaper to replace than
    // to submit, since a refusal costs a round trip and a new picture is free.
    if (agreed < CONFIDENT_VOTES && round < tries) {
      log(
        chatId,
        `captcha ${round}: "${code}" only ${agreed} agreed; redrawing`
      );
      continue;
    }
    if (await answerCaptcha(page, code)) {
      log(chatId, `captcha ${round}: "${code}" accepted (${agreed} agreed)`);
      return true;
    }
    log(chatId, `captcha ${round}: "${code}" refused (${agreed} agreed)`);
  }
  log(chatId, `the captcha beat ${tries} readings; asking the chat`);
  return false;
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
  const { applicant, values, rehearsal } = declarationFor(session, {
    log,
    chatId,
  });
  if (rehearsal) {
    await ctx.reply(
      strings.arrivalRehearsal(rehearsal, session.data?.entryDate)
    );
  }

  await chooseNationality(held.page, applicant.nationality).catch((error) =>
    log(chatId, `the nationality did not take: ${error.message}`)
  );

  // The built declaration wins over the raw record. It holds the values that
  // are the same for every e-visa traveller — the visa type, the issuing
  // department — which the record has no field for at all, so a record laid
  // over the top puts those back to nothing.
  const result = await fillDeclaration(held.page, {
    ...applicant,
    ...values,
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

  if (result.expired) {
    log(chatId, `the declaration expired: ${result.expired}`);
    await closeDeclaration(session);
    await ctx.reply(strings.arrivalExpired);
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
 * Puts what the chat has just sent onto the declaration already open.
 *
 * The same promise the visa form makes: send a correction in your own words
 * and the form is filled again from everything known, with the page coming
 * back. Nothing is asked for one field at a time.
 */
export function declarationRefiller(deps) {
  const { sessions, log } = deps;
  return async function refill(ctx, chatId) {
    const held = sessions.get(chatId).arrival;
    if (!held || held.stage !== 'form') {
      return;
    }
    try {
      await fillAndShow({ ...deps, ctx, chatId });
    } catch (error) {
      log(chatId, `the declaration did not take it: ${error.message}`);
    }
  };
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
