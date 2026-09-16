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
import {
  openDeclaration,
  answerCaptcha,
  captchaIsUp,
  chooseNationality,
  fillDeclaration,
  readDeclaration,
  photographDeclaration,
  offeredArrivalDates,
  readCaptchaImage,
  refreshCaptchaImage,
  readCaptchaText,
  FORM_FIELDS,
} from './evisa-prearrival-form.mjs';
import {
  fillTrip,
  provinceAsNamedHere,
  readTrip,
  TRIP_FIELDS,
  wardAsNamedHere,
} from './evisa-prearrival-trip.mjs';
import {
  returnToPassenger,
  STEPS,
  turnTo,
  whichStep,
} from './evisa-prearrival-pages.mjs';
import { buildDeclaration, fullNameOf } from './evisa-prearrival.mjs';
import { parseVietnamAddress } from './evisa-vietnam-address.mjs';
import { FIELD_DEFAULTS } from './evisa-schema.mjs';
import { describeDocumentIssues } from './evisa-document-feedback.mjs';
import {
  arrivalAnswerFor,
  sendArrivalAnswer,
} from './evisa-arrival-answer.mjs';
import {
  holdDeclarationCaptcha,
  takeCaptchaResumeStage,
} from './evisa-arrival-captcha-stage.mjs';
import { confirmDeclarationReview } from './evisa-arrival-review.mjs';
import {
  arrivalDateOverride,
  declarationFor,
} from './evisa-arrival-declaration.mjs';
import {
  checkpointBrowser,
  stopBrowserFeatures,
} from './evisa-browser-features.mjs';
import { tryOpeningCaptcha } from './evisa-arrival-opening.mjs';

export {
  arrivalAnswerFor,
  sendArrivalAnswer,
} from './evisa-arrival-answer.mjs';
export { declarationFiler } from './evisa-arrival-filing.mjs';
export { declarationEmailCodeTaker } from './evisa-arrival-email-stage.mjs';
export { confirmDeclarationReview } from './evisa-arrival-review.mjs';
export { arrivalDateOverride, declarationFor };

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

async function showOpenedDeclaration({
  session,
  opened,
  ctx,
  chatId,
  sessions,
  log,
  MESSAGES,
  describeFilled,
  describeDeclaration,
  InputFile,
  askCaptcha,
}) {
  session.arrival.stage = 'form';
  await fillAndShow({
    ctx,
    chatId,
    sessions,
    log,
    MESSAGES,
    describeFilled,
    describeDeclaration,
    InputFile,
    askCaptcha,
  });
  return { asked: false, solved: true, page: opened.page };
}

/**
 * Opens the site and asks the chat to read the captcha that gates it.
 *
 * The browser is kept on the session, since the code that comes back has to
 * reach this very page: a second browser would show a different picture.
 */
export async function startDeclaration(options) {
  return await startDeclarationWith({
    ...options,
    describeDeclaration: options.describeDeclaration ?? null,
    InputFile: options.InputFile ?? null,
    ocr: options.ocr ?? null,
    tries: options.tries ?? CAPTCHA_TRIES,
    headless: options.headless ?? true,
    debugPort: options.debugPort ?? 0,
    downloadsPath: options.downloadsPath ?? null,
    trace: options.trace ?? null,
  });
}

async function startDeclarationWith({
  ctx,
  chatId,
  sessions,
  log,
  askCaptcha,
  MESSAGES,
  describeFilled,
  describeDeclaration,
  // grammY's file wrapper; without it the declaration goes as words.
  InputFile,
  ocr,
  tries,
  headless,
  debugPort,
  downloadsPath,
  trace,
}) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  log(chatId, 'opening the pre-arrival declaration');
  const opened = await openDeclaration({
    headless,
    debugPort,
    downloadsPath,
    traceOutput: trace?.browserPathFor(chatId, 'prearrival') ?? null,
    onTraceCheckpoint: trace?.browserObserver(chatId) ?? null,
  });
  session.arrival = { ...opened, stage: 'captcha' };
  // No dialog gating the page means the form itself is already in front of
  // us, so it is filled. Left at the captcha stage the chat would hold a
  // browser showing a ready form that nothing would ever type into.
  if (!(await captchaIsUp(opened.page))) {
    log(chatId, 'the declaration opened with no captcha on it');
    return await showOpenedDeclaration({
      session,
      opened,
      ctx,
      chatId,
      sessions,
      log,
      MESSAGES,
      describeFilled,
      describeDeclaration,
      InputFile,
      askCaptcha,
    });
  }

  // The bot has one go at reading it, and only submits that reading if the
  // engines agree on it. Anything else goes to the traveller, who reads these
  // better than any of them and whose attempt is not a bot hammering a
  // government site's defences.
  const attempt = await tryOpeningCaptcha({
    page: opened.page,
    ctx,
    chatId,
    strings,
    log,
    askCaptcha,
    ocr,
    tries,
    solveCaptcha,
    askAfterRounds: ASK_AFTER_ROUNDS,
  });
  if (attempt.solved) {
    return await showOpenedDeclaration({
      session,
      opened,
      ctx,
      chatId,
      sessions,
      log,
      MESSAGES,
      describeFilled,
      describeDeclaration,
      InputFile,
      askCaptcha,
    });
  }
  // The picture is already with the traveller, and the page is holding it
  // for them. Sending another would replace the one they are reading.
  if (attempt.asked) {
    return { asked: true, page: opened.page };
  }
  // Nothing to send and nothing to read: the site is not issuing codes.
  if (attempt.stalled) {
    await closeDeclaration(session);
    await sendSiteStalled({ ctx, chatId, session, strings, InputFile, log });
    return { asked: false, stalled: true };
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
  // No picture on the page and none asked for: the site gave the bot nothing
  // to work with, and the chat hears that in place of silence.
  if (!asked) {
    await closeDeclaration(session);
    await sendSiteStalled({ ctx, chatId, session, strings, InputFile, log });
  }
  return { asked, page: opened.page };
}

/** One answer when the declaration site issued no CAPTCHA at all. */
function sendSiteStalled({ ctx, chatId, session, strings, InputFile, log }) {
  return sendArrivalAnswer({
    ctx,
    chatId,
    answer: {
      caption: [
        strings.arrivalSiteStalled,
        describeDocumentIssues(session, strings),
      ]
        .filter(Boolean)
        .join('\n\n'),
      shot: null,
    },
    session,
    strings,
    InputFile,
    log,
  });
}

/**
 * How many of the readings must agree before a code is worth submitting.
 *
 * Measured against the live site: accepted codes carried most of the votes,
 * refused ones two to four. Below this a fresh picture is the better move.
 */
export const CONFIDENT_VOTES = 6;

/**
 * How many pictures the bot reads for itself before the chat is asked.
 *
 * One. This is a government immigration site, and a bot working through six
 * pictures a minute against its captcha looks exactly like something being
 * attacked — the cost of being blocked there falls on a traveller who then
 * cannot file at all, which is far worse than being asked to read a picture.
 * So the bot reads once, and whatever comes of that the picture goes to the
 * person, who can read it better anyway.
 *
 * Asking hands the picture over: the bot stops there and the page keeps the
 * picture the chat was shown, so the code that comes back is answered against
 * the one the traveller actually read. A bot that kept reading would redraw
 * it, and every code they sent would be refused for a picture since replaced.
 */
export const ASK_AFTER_ROUNDS = 1;

/**
 * How many pictures the bot may submit a reading of, at most.
 *
 * One, for the same reason. A refused code costs the site a round trip, and
 * repeated wrong answers are what a defence counts. The one reading is worth
 * submitting because it is free when right and hands over when wrong.
 */
export const CAPTCHA_TRIES = 1;

/**
 * Reads the captcha, tries that reading once, and hands the picture over.
 *
 * `onRound` is told after a picture that did not pass, so the caller can put
 * it in front of the person who can actually read it.
 */
export async function solveCaptcha({
  page,
  chatId,
  log,
  ocr,
  tries = CAPTCHA_TRIES,
  onRound = null,
  // Told when the site itself draws no picture, which is not a captcha the
  // bot failed to read but a declaration that cannot be started at all.
  onStalled = null,
}) {
  const { renderImage, withImageFile, ...rest } = ocr;
  for (let round = 1; round <= tries; round += 1) {
    // Pressing the site's own Reload after it served nothing is not a captcha
    // attempt — no answer is being submitted — so it stays whatever the limit
    // on attempts is. Without it a moment's hiccup ends the declaration.
    const bytes = await aPictureToRead(page, chatId, log, true);
    if (!bytes) {
      log(chatId, 'the site is drawing no captcha at all');
      await onStalled?.();
      return false;
    }
    const img = await withImageFile(bytes, (file) => renderImage(file));
    const { code, agreed } = readCaptchaText(img, { renderImage, ...rest });
    // How many readings agreed says how likely the code is right: every code
    // the site accepted had most of them behind it, and every one it refused
    // had a handful. A reading with a handful behind it is not submitted at
    // all — a wrong answer is a wrong answer as far as the site's defences
    // are concerned, and the picture is about to go to someone who can read
    // it properly regardless.
    const worthTrying = Boolean(code) && agreed >= CONFIDENT_VOTES;
    if (worthTrying && (await answerCaptcha(page, code))) {
      log(chatId, `captcha ${round}: "${code}" accepted (${agreed} agreed)`);
      return true;
    }
    log(chatId, `captcha ${round}: ${whatHappened(code, agreed, worthTrying)}`);

    // Asked before anything is redrawn, so the picture the chat is sent is
    // the one still on the page. A handover that ends the loop here leaves it
    // there: the code that comes back is answered against the very picture
    // the traveller read it from.
    if (await onRound?.(round)) {
      return false;
    }
  }
  log(chatId, `the captcha beat ${tries} reading(s); asking the chat`);
  return false;
}

/**
 * The captcha picture on the page, asking the site again if it served none.
 *
 * Its captcha service fails on its own sometimes — the dialog reads "CAPTCHA
 * is unavailable" over an empty box, above "Failed to get CAPTCHA" — and
 * recovers within seconds. Its own Reload is the only way to ask again, so an
 * outage that passes costs a few seconds and nobody needs to hear about it.
 */
async function aPictureToRead(page, chatId, log, mayRetry) {
  const bytes = await readCaptchaImage(page);
  if (bytes || !mayRetry) {
    return bytes;
  }
  log(chatId, 'the site served no picture; asking it again');
  return refreshCaptchaImage(page).catch(() => null);
}

/** What to say in the log about a picture that did not get through. */
function whatHappened(code, agreed, tried) {
  if (!code) {
    return 'nothing readable; not submitted';
  }
  return tried
    ? `"${code}" refused (${agreed} agreed)`
    : `"${code}" had only ${agreed} readings behind it; not submitted`;
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
  describeDeclaration = null,
  InputFile = null,
  resumeAfterCaptcha = null,
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
  const resumeStage = takeCaptchaResumeStage(held);
  held.stage = resumeStage ?? 'form';
  log(chatId, 'the declaration captcha was accepted');
  if (resumeStage) {
    await resumeAfterCaptcha?.(ctx, chatId, resumeStage);
    return true;
  }
  await fillAndShow({
    ctx,
    chatId,
    sessions,
    log,
    MESSAGES,
    describeFilled,
    describeDeclaration,
    InputFile,
    askCaptcha,
  });
  return true;
}

/**
 * Fills the declaration and shows the traveller what stands on it.
 *
 * Nothing is pressed at the end: page 1 is photographed and left open until
 * the traveller confirms that this checkpoint may advance.
 */
// The branches mirror distinct states of the live government page.
// eslint-disable-next-line complexity, max-lines-per-function
export async function fillAndShow({
  ctx,
  chatId,
  sessions,
  log,
  MESSAGES,
  describeFilled,
  // What is known and what is still wanted, laid out for the chat. Used when
  // the form is open but the record is empty, so the one message that says
  // the way is clear also says what would clear it.
  describeDeclaration = null,
  InputFile = null,
  askCaptcha = () => Promise.resolve(false),
}) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  const held = session.arrival;
  const { applicant, values, rehearsal, nameCorrections } = declarationFor(
    session,
    {
      log,
      chatId,
    }
  );
  held.rehearsal = rehearsal;
  held.nameCorrections = nameCorrections;

  // The nationality gates the whole form: the site draws no field until one
  // is chosen. Without it there is nothing to type into yet, so the prepared
  // page waits and a single message tells the chat the way is clear and what
  // to send. Why the site wants a nationality first is the site's business;
  // the traveller needs to know it is their turn.
  if (!applicant.nationality) {
    log(chatId, 'the form is open and waiting: the record has no nationality');
    const caption = [
      rehearsal
        ? strings.arrivalRehearsal(rehearsal, session.data?.entryDate)
        : '',
      whatIsStillWanted(strings, session, describeDeclaration),
      describeDocumentIssues(session, strings),
    ]
      .filter(Boolean)
      .join('\n\n');
    await sendArrivalAnswer({
      ctx,
      chatId,
      answer: { caption, shot: null },
      session,
      strings,
      InputFile,
      log,
    });
    return { filled: [], missing: [], failed: [], waiting: true };
  }

  const current = await whichStep(held.page);
  let atPassenger = false;
  if (current.at < 0) {
    try {
      await chooseNationality(held.page, applicant.nationality);
      if (await captchaIsUp(held.page)) {
        await holdDeclarationCaptcha({
          ctx,
          chatId,
          held,
          strings,
          log,
          askCaptcha,
          resumeStage: 'form',
        });
        return { filled: [], missing: [], failed: [], waiting: true };
      }
      atPassenger = true;
    } catch (error) {
      log(chatId, `the nationality did not take: ${error.message}`);
    }
  } else {
    atPassenger = await returnToPassenger(held.page, {
      log: (said) => log(chatId, said),
    });
  }
  if (!atPassenger) {
    await sendArrivalAnswer({
      ctx,
      chatId,
      answer: {
        caption: [
          strings.arrivalFormUnavailable,
          describeDocumentIssues(session, strings),
        ]
          .filter(Boolean)
          .join('\n\n'),
        shot: null,
      },
      session,
      strings,
      InputFile,
      log,
    });
    return { filled: [], missing: [], failed: [], waiting: true };
  }
  // A correction has left the review already. Mark it immediately, before
  // filling or awaiting the site, so a concurrent "submit" cannot be routed
  // to a declaration that is no longer on its review page.
  held.stage = 'form';

  const passportImage = passportToUpload(session, held);
  // One confirmation advances one page. Fill and show the passenger page
  // now, then leave the browser standing on it until the traveller has
  // checked both this picture and the live form and says to continue.
  const first = await fillDeclaration(
    held.page,
    // The built declaration wins over the raw record. It holds the values
    // that are the same for every e-visa traveller — the visa type and the
    // issuing department — which the raw record has no field for.
    { ...applicant, ...values },
    { passportImage }
  );
  if (passportImage && first.filled?.includes('passportImage')) {
    held.uploaded = { ...held.uploaded, passportPage: true };
  }
  log(chatId, `page 1/3 ${STEPS[0]}: ${pageResult(first)}`);
  if (await captchaIsUp(held.page)) {
    await holdDeclarationCaptcha({
      ctx,
      chatId,
      held,
      strings,
      log,
      askCaptcha,
      resumeStage: 'form',
    });
    return { ...first, waiting: true };
  }
  const captured = await captureThePage({
    chatId,
    page: held.page,
    at: 0,
    title: STEPS[0],
    result: first,
    log,
    InputFile,
  });
  let tooEarly = null;
  if (first.arrival?.tooEarly) {
    const offered = await offeredArrivalDates(held.page);
    log(
      chatId,
      `too early to declare: wanted ${applicant.arrivalDate}, offered ${offered.join(', ')}`
    );
    tooEarly = { wanted: applicant.arrivalDate, offered };
  }
  const expired = Boolean(first.expired);
  const ready = !tooEarly && !expired && !pageNeedsWork(first);
  // Even an incomplete passenger page is a real checkpoint: the traveller
  // can correct it directly in the visible browser and confirm again. Only a
  // date the site cannot take, or an expired page, is not advanceable.
  held.stage = !tooEarly && !expired ? 'passenger' : 'form';
  if (expired) {
    log(chatId, `the declaration expired: ${first.expired}`);
    await closeDeclaration(session);
  }
  const answer = arrivalAnswerFor({
    capture: captured,
    session,
    strings,
    describeFilled,
    ready,
    rehearsal: rehearsal
      ? strings.arrivalRehearsal(rehearsal, session.data?.entryDate)
      : '',
    tooEarly,
    expired,
    nameCorrections,
  });
  held.pageDelivered = await sendArrivalAnswer({
    ctx,
    chatId,
    answer,
    session,
    strings,
    InputFile,
    log,
  });
  return { ...first, capture: captured };
}

/** A compact, value-free page result for the audit log. */
function pageResult(result = {}) {
  const names = (items = []) =>
    items.map((item) => String(item).split(':')[0].trim()).join(', ');
  return (
    `${result.filled?.length ?? 0} filled [${names(result.filled)}], ` +
    `${result.missing?.length ?? 0} missing [${names(result.missing)}], ` +
    `${result.failed?.length ?? 0} failed [${names(result.failed)}]`
  );
}

/** Required information that still prevents the current page from turning. */
function pageNeedsWork(result = {}) {
  const blockingFailures = (result.failed ?? []).filter(
    (failure) =>
      !/^passportImage:\s*the site read nothing from it$/i.test(
        String(failure).trim()
      )
  );
  return Boolean(
    result.missing?.length || blockingFailures.length || result.refused?.length
  );
}

/** What a confirmation means while a declaration browser exists. */
export function arrivalConfirmationAction(arrival) {
  if (!arrival) {
    return null;
  }
  if (arrival.stage === 'passenger' || arrival.stage === 'trip') {
    return 'advance';
  }
  if (arrival.stage === 'review') {
    return 'file';
  }
  // A declaration owns confirmations throughout its lifetime. In particular,
  // a captcha, incomplete page, or in-flight advance must never fall through
  // and operate the separate e-visa application workflow.
  return 'hold';
}

/**
 * Advances exactly one checked declaration page and sends exactly one image.
 *
 * The browser remains visible and on the page sent to Telegram. A second
 * confirmation advances from there; only a third confirmation, from Review,
 * is handled by `declarationFiler` and can submit anything.
 */
export function declarationAdvancer(deps) {
  const {
    sessions,
    log,
    MESSAGES,
    describeFilled,
    InputFile = null,
    showStatus = () => () => {},
    stepOf = whichStep,
    turnPage = turnTo,
    fillTripPage = fillTrip,
    readPassengerPage = readPassengerCheckpoint,
    readTripPage = readTripCheckpoint,
    capturePage = captureThePage,
    secureReview = confirmDeclarationReview,
    sendPage = sendArrivalAnswer,
    askCaptcha = () => Promise.resolve(false),
    captchaOnPage = captchaIsUp,
    holdCaptcha = holdDeclarationCaptcha,
  } = deps;
  return async function advance(ctx, chatId) {
    const session = sessions.get(chatId);
    const held = session.arrival;
    if (!held || !['passenger', 'trip'].includes(held.stage)) {
      return false;
    }
    const from = held.stage;
    const strings = MESSAGES[session.language];
    const busy = showStatus(ctx, 'typing');
    held.stage = 'advancing';
    try {
      if (await captchaOnPage(held.page)) {
        await holdCaptcha({
          ctx,
          chatId,
          held,
          strings,
          log,
          askCaptcha,
          resumeStage: from,
        });
        return false;
      }
      const current = await stepOf(held.page);
      if (from === 'passenger') {
        return await advancePassenger({
          deps: {
            ctx,
            chatId,
            session,
            held,
            strings,
            log,
            describeFilled,
            InputFile,
            step: current,
            turnPage,
            fillTripPage,
            readPassengerPage,
            capturePage,
            sendPage,
            askCaptcha,
            holdCaptcha,
          },
        });
      }
      return await advanceTrip({
        deps: {
          ctx,
          chatId,
          session,
          held,
          strings,
          log,
          describeFilled,
          InputFile,
          step: current,
          turnPage,
          readTripPage,
          capturePage,
          secureReview,
          sendPage,
          askCaptcha,
          holdCaptcha,
        },
      });
    } catch (error) {
      held.stage = from;
      log(chatId, `the declaration could not advance: ${error.message}`);
      await ctx.reply(strings.arrivalNotAdvanced).catch(() => {});
      return false;
    } finally {
      busy();
    }
  };
}

/** Passenger confirmation: turn once, fill trip, show it, and stop. */
async function advancePassenger({ deps }) {
  const {
    ctx,
    chatId,
    session,
    held,
    strings,
    log,
    describeFilled,
    InputFile,
    step,
    turnPage,
    fillTripPage,
    readPassengerPage,
    capturePage,
    sendPage,
    askCaptcha,
    holdCaptcha,
  } = deps;
  if (step.at === 0) {
    const live = await readPassengerPage(held.page, held);
    if (pageNeedsWork(live.result) || held.pageDelivered === false) {
      held.stage = 'passenger';
      const capture = await capturePage({
        chatId,
        page: held.page,
        at: 0,
        title: STEPS[0],
        result: live.result,
        log,
        InputFile,
      });
      await sendCheckpoint({
        ctx,
        chatId,
        session,
        held,
        strings,
        describeFilled,
        InputFile,
        log,
        capture,
        ready: !pageNeedsWork(live.result),
        sendPage,
      });
      return false;
    }
    const moved = await turnPage(held.page, STEPS[1]);
    if (moved.captcha) {
      await holdCaptcha({
        ctx,
        chatId,
        held,
        strings,
        log,
        askCaptcha,
        resumeStage: 'passenger',
      });
      return false;
    }
    if (!moved.turned) {
      held.stage = 'passenger';
      const capture = await capturePage({
        chatId,
        page: held.page,
        at: 0,
        title: STEPS[0],
        result: live.result,
        log,
        InputFile,
      });
      await sendCheckpoint({
        ctx,
        chatId,
        session,
        held,
        strings,
        describeFilled,
        InputFile,
        log,
        capture,
        ready: false,
        refused: moved.refused,
        sendPage,
      });
      return false;
    }
  } else if (step.at !== 1) {
    throw new Error(`expected page 1 or 2, found step ${step.at + 1}`);
  }

  const { applicant, values } = declarationFor(session, { log, chatId });
  const result = await fillTripPage(held.page, tripFrom(applicant, values), {
    log: (said) => log(chatId, said),
  });
  log(chatId, `page 2/3 ${STEPS[1]}: ${pageResult(result)}`);
  const capture = await capturePage({
    chatId,
    page: held.page,
    at: 1,
    title: STEPS[1],
    result,
    log,
    InputFile,
  });
  held.stage = 'trip';
  const sent = await sendCheckpoint({
    ctx,
    chatId,
    session,
    held,
    strings,
    describeFilled,
    InputFile,
    log,
    capture,
    ready: !pageNeedsWork(result),
    sendPage,
  });
  // A logical checkpoint requires successful delivery of its visible page.
  if (!sent) {
    held.stage = 'passenger';
  }
  return sent;
}

/** Trip confirmation: turn once, show Review, and leave Submit untouched. */
async function advanceTrip({ deps }) {
  const {
    ctx,
    chatId,
    session,
    held,
    strings,
    log,
    describeFilled,
    InputFile,
    step,
    turnPage,
    readTripPage,
    capturePage,
    secureReview,
    sendPage,
    askCaptcha,
    holdCaptcha,
  } = deps;
  if (step.at === 1) {
    const live = await readTripPage(held.page);
    if (pageNeedsWork(live.result) || held.pageDelivered === false) {
      held.stage = 'trip';
      const capture = await capturePage({
        chatId,
        page: held.page,
        at: 1,
        title: STEPS[1],
        result: live.result,
        log,
        InputFile,
      });
      await sendCheckpoint({
        ctx,
        chatId,
        session,
        held,
        strings,
        describeFilled,
        InputFile,
        log,
        capture,
        ready: !pageNeedsWork(live.result),
        sendPage,
      });
      return false;
    }
    const moved = await turnPage(held.page, STEPS[2]);
    if (moved.captcha) {
      await holdCaptcha({
        ctx,
        chatId,
        held,
        strings,
        log,
        askCaptcha,
        resumeStage: 'trip',
      });
      return false;
    }
    if (!moved.turned) {
      held.stage = 'trip';
      const capture = await capturePage({
        chatId,
        page: held.page,
        at: 1,
        title: STEPS[1],
        result: live.result,
        log,
        InputFile,
      });
      await sendCheckpoint({
        ctx,
        chatId,
        session,
        held,
        strings,
        describeFilled,
        InputFile,
        log,
        capture,
        ready: false,
        refused: moved.refused,
        sendPage,
      });
      return false;
    }
  } else if (step.at !== 2) {
    throw new Error(`expected page 2 or 3, found step ${step.at + 1}`);
  }

  const reviewConfirmed = await secureReview(held.page);
  log(
    chatId,
    `page 3/3 ${STEPS[2]}: confirmation ${reviewConfirmed ? 'checked' : 'could not be checked'}; Submit untouched`
  );
  if (!reviewConfirmed) {
    held.stage = 'trip';
    await ctx.reply(strings.arrivalReviewSafetyUnknown).catch(() => {});
    return false;
  }
  const capture = await capturePage({
    chatId,
    page: held.page,
    at: 2,
    title: STEPS[2],
    result: { filled: [], missing: [], failed: [] },
    log,
    InputFile,
  });
  capture.reviewConfirmed = reviewConfirmed;
  held.stage = 'review';
  const sent = await sendCheckpoint({
    ctx,
    chatId,
    session,
    held,
    strings,
    describeFilled,
    InputFile,
    log,
    capture,
    ready: true,
    sendPage,
  });
  if (!sent) {
    held.stage = 'trip';
  }
  return sent;
}

/** Sends one stage with its instruction as the last caption block. */
async function sendCheckpoint({
  ctx,
  chatId,
  session,
  held,
  strings,
  describeFilled,
  InputFile,
  log,
  capture,
  ready,
  refused = [],
  sendPage,
}) {
  const sent = await sendPage({
    ctx,
    chatId,
    answer: arrivalAnswerFor({
      capture,
      session,
      strings,
      describeFilled,
      ready,
      refused,
      nameCorrections: capture.at === 0 ? held.nameCorrections : [],
      rehearsal: held.rehearsal
        ? strings.arrivalRehearsal(
            held.rehearsal,
            session.data?.entryDate ?? session.data?.arrivalDate
          )
        : '',
    }),
    session,
    strings,
    InputFile,
    log,
  });
  held.pageDelivered = Boolean(sent);
  return sent;
}

/** Required passenger values as they stand after possible manual edits. */
async function readPassengerCheckpoint(page, held = {}) {
  const values = await readDeclaration(page);
  const required = FORM_FIELDS.map(({ key }) => key);
  if (!values.gender) {
    required.push('sex');
  }
  if (!values.arrivalDate) {
    required.push('arrivalDate');
  }
  const notes = await page
    .getByRole('checkbox')
    .first()
    .isChecked()
    .catch(() => false);
  if (notes) {
    values.readTheNotes = true;
  } else {
    required.push('readTheNotes');
  }
  const passport =
    held.uploaded?.passportPage ||
    (await page
      .locator('input[name="passportImage"]')
      .first()
      .evaluate((input) => Boolean(input.files?.length))
      .catch(() => false));
  if (passport) {
    values.passportImage = true;
  } else {
    required.push('passportImage');
  }
  const missing = [...new Set(required)].filter((key) => {
    if (key === 'sex') {
      return !values.gender;
    }
    return !values[key];
  });
  return {
    values,
    result: {
      filled: Object.keys(values),
      missing,
      failed: [],
    },
  };
}

/** Required trip values as they stand after possible manual edits. */
async function readTripCheckpoint(page) {
  const values = await readTrip(page);
  return tripCheckpointFromValues(values);
}

/** Completeness of the visible trip page; optional fields stay optional. */
export function tripCheckpointFromValues(values = {}) {
  const required = TRIP_FIELDS.filter(({ required }) => required !== false).map(
    ({ key }) => key
  );
  // The gate is filled by a valid flight and cannot be typed by the user. If
  // it is absent, the actionable answer is to choose the flight again.
  const missing = required.filter((key) => !values[key]);
  if (!values.borderGate && !missing.includes('vehicleNumber')) {
    missing.push('vehicleNumber');
  }
  return {
    values,
    result: {
      filled: Object.keys(values),
      missing,
      failed: [],
    },
  };
}

/**
 * What the trip page is filled from.
 *
 * The record holds the journey under the names the rest of the bot uses, and
 * the trip page wants its own. The ticket gives the flight and where the
 * journey began, and a booking can give the place to stay. The live form opens
 * with Hotel selected, so that remains the default unless the traveller gave
 * another kind of stay. Its optional departure date remains empty unless the
 * traveller actually supplied one; a visa expiry is not a planned departure.
 */
export function tripFrom(applicant = {}, values = {}) {
  // `values` contains generic declaration defaults as well as copied record
  // values. Read the source record first so those defaults cannot overwrite
  // a trip detail the traveller supplied explicitly.
  const sources = [applicant, values];
  const staying = whereTheyAreStaying(applicant, values);
  return {
    modeOfTravel: firstKnown(firstFrom(sources, 'modeOfTravel'), 'Air'),
    vehicleNumber: firstFrom(sources, 'vehicleNumber', 'flightNumber'),
    departedFrom: countryFlownFrom(...sources),
    purpose: firstKnown(firstFrom(sources, 'purpose'), 'Tourist'),
    accommodationType: firstKnown(
      firstFrom(sources, 'accommodationType'),
      'Hotel'
    ),
    province: staying.province,
    ward: staying.ward,
    accommodationAddress: staying.address,
    workplace: firstFrom(sources, 'workplace'),
    departureDate: firstFrom(sources, 'departureDate'),
  };
}

/** The first value that is present, treating a blank string as no value. */
function firstKnown(...values) {
  return (
    values.find(
      (value) =>
        value !== null &&
        value !== undefined &&
        (typeof value !== 'string' || value.trim())
    ) ?? null
  );
}

/** The first named value in the first record that knows one. */
function firstFrom(records, ...keys) {
  for (const record of records) {
    const found = firstKnown(...keys.map((key) => record?.[key]));
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** The stay, translated from the record into one coherent three-field tuple. */
function whereTheyAreStaying(applicant, values) {
  const tripAddress = firstKnown(applicant.accommodationAddress);
  const tripProvince = firstKnown(applicant.province, values.province);
  const tripWard = firstKnown(applicant.ward, values.ward);
  if (tripAddress || tripProvince || tripWard) {
    const parsed = tripAddress ? parseVietnamAddress(tripAddress) : {};
    return {
      province: provinceAsNamedHere(
        firstKnown(tripProvince, parsed.provinceInVietnam)
      ),
      ward: wardAsNamedHere(
        firstKnown(tripWard, parsed.wardInVietnam, parsed.townInVietnam)
      ),
      address: tripAddress
        ? firstKnown(parsed.addressInVietnam, tripAddress)
        : null,
    };
  }

  // The e-visa address is a separate, older tuple. `buildDeclaration` copies
  // it to `values.accommodationAddress`, so keep its administrative fields
  // with it and use none of them when a trip-specific tuple was supplied.
  const evisaAddress = firstKnown(
    applicant.addressInVietnam,
    values.addressInVietnam,
    values.accommodationAddress
  );
  const evisaProvince = firstKnown(
    applicant.provinceInVietnam,
    values.provinceInVietnam
  );
  const evisaWard = firstKnown(applicant.wardInVietnam, values.wardInVietnam);
  if (!evisaAddress && !evisaProvince && !evisaWard) {
    return {
      province: provinceAsNamedHere(FIELD_DEFAULTS.provinceInVietnam),
      ward: wardAsNamedHere(FIELD_DEFAULTS.wardInVietnam),
      address: FIELD_DEFAULTS.addressInVietnam,
    };
  }
  if (!evisaAddress) {
    return {
      province: provinceAsNamedHere(evisaProvince),
      ward: wardAsNamedHere(evisaWard),
      address: null,
    };
  }
  const parsed = parseVietnamAddress(evisaAddress);
  return {
    province: provinceAsNamedHere(
      firstKnown(evisaProvince, parsed.provinceInVietnam)
    ),
    ward: wardAsNamedHere(
      firstKnown(evisaWard, parsed.wardInVietnam, parsed.townInVietnam)
    ),
    address: firstKnown(parsed.addressInVietnam, evisaAddress),
  };
}

/** The country behind the origin wording an inbound ticket prints. */
function countryFlownFrom(...records) {
  const said = String(
    firstFrom(records, 'departedFrom', 'departureAirport', 'flightFrom') ?? ''
  ).trim();
  if (!said) {
    return null;
  }
  // The current ticket reader returns the airport name. These are the origin
  // names present on the Air India itinerary this flow already understands.
  if (/\b(?:goa|mopa|delhi|india)\b/i.test(said)) {
    return 'India';
  }
  // A value supplied as a country already belongs to the declaration.
  return said;
}

/** Reads and photographs one page for its own checkpoint answer. */
async function captureThePage({
  chatId,
  page,
  at,
  title,
  result,
  log,
  InputFile,
}) {
  if (await captchaIsUp(page)) {
    throw new Error(`refusing to photograph ${title}: CAPTCHA is covering it`);
  }
  const shot = InputFile
    ? await photographDeclaration(page).catch((error) => {
        log(chatId, `could not photograph ${title}: ${error.message}`);
        return null;
      })
    : null;
  // Only the first page is read back off the screen. Its fields are the ones
  // the bot's own reading of the passport is checked against, and it is the
  // page those fields are on. Asked for them anywhere else, every one of them
  // waits out its timeout for a field that page has not got — twenty seconds
  // apiece, which is the walk stopped dead in front of the traveller.
  const onThePage =
    at === 0
      ? await readDeclaration(page).catch(() => ({}))
      : at === 1
        ? await readTrip(page).catch(() => ({}))
        : {};
  await checkpointBrowser(
    page,
    `prearrival-${String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')}`,
    { actor: 'automation', reason: 'confirmation' }
  );
  return { at, title, result, onThePage, shot };
}

/**
 * One message saying the way is clear and what is still wanted.
 *
 * The captcha is behind us and the page is waiting, so this is the moment the
 * traveller can act — and everything they have to do fits in the message that
 * tells them so. Sent separately, the same words cost a second notification
 * that carries nothing the first could not.
 */
function whatIsStillWanted(strings, session, describeDeclaration) {
  const applicant = {
    ...(session.data ?? {}),
    fullName: fullNameOf(session.data ?? {}),
  };
  const { values, missing } = buildDeclaration(applicant);
  return [
    strings.arrivalNothingToFill,
    describeDeclaration?.(values, missing, session.language),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The passport picture to put on the page, or nothing.
 *
 * The site reads an uploaded passport on its own server and fills what it
 * finds, which is a second opinion on the bot's reading and the only way to
 * check it. Sent once per page: a form already carrying the picture is not
 * improved by another copy, and the upload costs three seconds of waiting.
 */
function passportToUpload(session, held) {
  if (held.uploaded?.passportPage) {
    return null;
  }
  const image = session.uploads?.passportPage ?? null;
  return image;
}

/**
 * Puts what the chat has just sent onto the declaration already open.
 *
 * The same promise the visa form makes: send a correction in your own words
 * and the form is filled again from everything known, with the page coming
 * back. Nothing is asked for one field at a time.
 */
export function declarationRefiller(deps) {
  const {
    sessions,
    log,
    showStatus = () => () => {},
    refillDeclaration = fillAndShow,
    restartDeclaration = startDeclaration,
  } = deps;
  return async function refill(ctx, chatId) {
    const session = sessions.get(chatId);
    const held = session.arrival;
    // A declaration standing on its review page is filled, not finished: a
    // correction sent now is a correction to what is on it, and the walk
    // starts again from the first page with the new value in hand.
    if (
      !held ||
      !['form', 'passenger', 'trip', 'review'].includes(held.stage)
    ) {
      return;
    }
    const busy = showStatus(ctx, 'typing');
    try {
      const current = await whichStep(held.page);
      if (current.at > 0) {
        // A correction starts a clean declaration so any CAPTCHA is handled
        // through the normal chat flow before the saved record is refilled.
        log(
          chatId,
          `restarting the declaration to correct page ${current.at + 1}`
        );
        await closeDeclaration(session);
        await restartDeclaration({ ...deps, ctx, chatId });
      } else {
        // Before nationality is chosen, or while page 1 itself is still open,
        // the correction can be applied without discarding the solved CAPTCHA.
        await refillDeclaration({ ...deps, ctx, chatId });
      }
    } catch (error) {
      log(chatId, `the declaration did not take it: ${error.message}`);
    } finally {
      busy();
    }
  };
}

/**
 * Files the declaration that is standing on its review page.
 *
 * This is the only thing in the bot that sends anything to the immigration
 * department, and it runs on one condition: the traveller asked for it, in
 * this chat, with the filled declaration already in front of them. The walk
 * never reaches here on its own — it stops at the review without pressing
 * Submit — so nothing files itself while somebody is reading.
 *
 * Everything is said out loud: what is about to happen, and what the site
 * made of it. A filing nobody is told about is one nobody can act on.
 */
/**
 * Opens the declaration for a chat, closing any left over from before.
 *
 * Two browsers on this site would show two captchas, and the code that came
 * back would be read against whichever page was found first.
 */
export function declarationOpener(deps) {
  const {
    sessions,
    log,
    MESSAGES,
    // Telegram's "typing…", held for as long as the work runs. Opening the
    // site, reading captchas until one is accepted and filling seventeen
    // fields takes the better part of a minute, and a chat with nothing on
    // it for that long is read as a bot that has died.
    showStatus = () => () => {},
  } = deps;
  return async function begin(ctx, chatId) {
    await closeDeclaration(sessions.get(chatId));
    const busy = showStatus(ctx, 'typing');
    try {
      await startDeclaration({ ...deps, ctx, chatId });
    } catch (error) {
      log(chatId, `the declaration did not open: ${error.message}`);
      await ctx
        .reply(MESSAGES[sessions.get(chatId).language].browserGone)
        .catch(() => {});
    } finally {
      busy();
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
  const { sessions, looksLikeCaptcha, showStatus = () => () => {} } = deps;
  return async function tookIt(ctx, chatId) {
    if (!sessions.get(chatId).arrival || !looksLikeCaptcha(ctx.message.text)) {
      return false;
    }
    // A code that is accepted is followed by the passenger-page fill, which
    // is the long part. The chat should see that something is happening.
    const busy = showStatus(ctx, 'typing');
    try {
      return await tookDeclarationCaptcha({
        ...deps,
        ctx,
        chatId,
        code: ctx.message.text,
      });
    } finally {
      busy();
    }
  };
}

/** Closes a declaration's browser, if one is open for the chat. */
export async function closeDeclaration(session = {}) {
  const held = session.arrival;
  if (!held) {
    return false;
  }
  session.arrival = null;
  await stopBrowserFeatures(held.page).catch(() => {});
  await held.browser.close().catch(() => {});
  return true;
}
