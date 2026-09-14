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
  photographDeclaration,
  offeredArrivalDates,
  readCaptchaImage,
  refreshCaptchaImage,
  readCaptchaText,
} from './evisa-prearrival-form.mjs';
import {
  fillTrip,
  provinceAsNamedHere,
  readTrip,
  wardAsNamedHere,
} from './evisa-prearrival-trip.mjs';
import {
  walkTheDeclaration,
  fileTheDeclaration,
} from './evisa-prearrival-pages.mjs';
import { buildDeclaration, fullNameOf } from './evisa-prearrival.mjs';
import { parseVietnamAddress } from './evisa-vietnam-address.mjs';
import { FIELD_DEFAULTS } from './evisa-schema.mjs';

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
  describeDeclaration = null,
  // grammY's file wrapper, passed in so this module needs no bot library of
  // its own. Without it the declaration goes as words, which is what the
  // tests take.
  InputFile = null,
  ocr = null,
  tries = CAPTCHA_TRIES,
  headless = true,
  debugPort = 0,
}) {
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  log(chatId, 'opening the pre-arrival declaration');
  const opened = await openDeclaration({ headless, debugPort });
  session.arrival = { ...opened, stage: 'captcha' };
  // No dialog gating the page means the form itself is already in front of
  // us, so it is filled. Left at the captcha stage the chat would hold a
  // browser showing a ready form that nothing would ever type into.
  if (!(await captchaIsUp(opened.page))) {
    log(chatId, 'the declaration opened with no captcha on it');
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
    });
    return { asked: false, solved: true, page: opened.page };
  }

  // The bot has one go at reading it, and only submits that reading if the
  // engines agree on it. Anything else goes to the traveller, who reads these
  // better than any of them and whose attempt is not a bot hammering a
  // government site's defences.
  let asked = false;
  // The site's own captcha service failing, which is neither a picture the
  // bot misread nor anything the traveller can put right by trying harder.
  let stalled = false;
  if (ocr) {
    const solved = await solveCaptcha({
      page: opened.page,
      chatId,
      log,
      ocr,
      tries,
      onStalled: () => {
        stalled = true;
      },
      // The picture goes to the traveller, and the bot stops there. Whatever
      // is on the page at this moment is what is sent — the picture it read,
      // if it submitted nothing, or the one the site drew in answer to a
      // refusal — and nothing touches the page afterwards, so the code that
      // comes back is answered against the very picture they read it from.
      onRound: async (round) => {
        if (asked || round < ASK_AFTER_ROUNDS) {
          return false;
        }
        asked = await askCaptcha(
          ctx,
          chatId,
          strings.arrivalCaptcha,
          opened.page
        );
        log(
          chatId,
          `captcha ${round}: ${asked ? 'asked the chat; the page keeps this picture' : 'no picture to send'}`
        );
        return asked;
      },
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
        describeDeclaration,
        InputFile,
      });
      return { asked: false, solved: true, page: opened.page };
    }
    // The picture is already with the traveller, and the page is holding it
    // for them. Sending another would replace the one they are reading.
    if (asked) {
      return { asked, page: opened.page };
    }
    // Nothing to send and nothing to read: the site is not issuing codes.
    // Said plainly, because a page reading "CAPTCHA is unavailable" with no
    // word from the bot looks like the bot is the thing that broke. The
    // browser goes with it: it is holding a dialog nobody can get past.
    if (stalled) {
      await closeDeclaration(session);
      await ctx.reply(strings.arrivalSiteStalled).catch(() => {});
      return { asked: false, stalled: true };
    }
  }

  asked = await askCaptcha(ctx, chatId, strings.arrivalCaptcha, opened.page);
  log(
    chatId,
    `declaration captcha ${asked ? 'sent to the chat' : 'not found'}`
  );
  // No picture on the page and none asked for: the site gave the bot nothing
  // to work with, and the chat hears that in place of silence.
  if (!asked) {
    await closeDeclaration(session);
    await ctx.reply(strings.arrivalSiteStalled).catch(() => {});
  }
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
    describeDeclaration,
    InputFile,
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
  // What is known and what is still wanted, laid out for the chat. Used when
  // the form is open but the record is empty, so the one message that says
  // the way is clear also says what would clear it.
  describeDeclaration = null,
  InputFile = null,
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

  // The nationality gates the whole form: the site draws no field until one
  // is chosen. Without it there is nothing to type into yet, so the prepared
  // page waits and a single message tells the chat the way is clear and what
  // to send. Why the site wants a nationality first is the site's business;
  // the traveller needs to know it is their turn.
  if (!applicant.nationality) {
    log(chatId, 'the form is open and waiting: the record has no nationality');
    await ctx
      .reply(whatIsStillWanted(strings, session, describeDeclaration), {
        parse_mode: 'HTML',
      })
      .catch(() => {});
    return { filled: [], missing: [], failed: [], waiting: true };
  }

  await chooseNationality(held.page, applicant.nationality).catch((error) =>
    log(chatId, `the nationality did not take: ${error.message}`)
  );

  const passportImage = passportToUpload(session, held);

  // The declaration is three pages, and each is shown as it is done: the
  // traveller watches it fill the way the visa form's applicant does, and a
  // page that goes wrong is seen at the page it went wrong on.
  const walk = await walkTheDeclaration({
    page: held.page,
    log: (said) => log(chatId, said),
    // The built declaration wins over the raw record. It holds the values
    // that are the same for every e-visa traveller — the visa type, the
    // issuing department — which the record has no field for at all, so a
    // record laid over the top puts those back to nothing.
    fillPassenger: () =>
      fillDeclaration(
        held.page,
        { ...applicant, ...values },
        { passportImage }
      ),
    fillTrip: () =>
      fillTrip(held.page, tripFrom(applicant, values), {
        log: (said) => log(chatId, said),
      }),
    onPage: ({ at, title, filled, missing, failed }) =>
      showThePage({
        ctx,
        chatId,
        page: held.page,
        at,
        title,
        result: { filled, missing, failed },
        session,
        describeFilled,
        log,
        strings,
        InputFile,
      }),
  });

  const first = walk.pages[0] ?? { filled: [], missing: [], failed: [] };
  if (first.arrival?.tooEarly) {
    const offered = await offeredArrivalDates(held.page);
    log(
      chatId,
      `too early to declare: wanted ${applicant.arrivalDate}, offered ${offered.join(', ')}`
    );
    await ctx.reply(strings.arrivalTooEarly(applicant.arrivalDate, offered));
    return first;
  }

  if (first.expired) {
    log(chatId, `the declaration expired: ${first.expired}`);
    await closeDeclaration(session);
    await ctx.reply(strings.arrivalExpired);
    return first;
  }

  // A page the site would not accept: it named the fields holding it up, so
  // the traveller is told which, in the site's own words.
  if (walk.reached < 2) {
    log(
      chatId,
      `the declaration stopped on ${walk.stopped}: ${walk.refused?.join('; ') || 'no reason given'}`
    );
    await ctx
      .reply(strings.arrivalPageRefused(walk.stopped, walk.refused ?? []), {
        parse_mode: 'HTML',
      })
      .catch(() => {});
  } else {
    // On the review, filled and waiting. The last press is the traveller's.
    held.stage = 'review';
    await ctx.reply(strings.arrivalAtTheReview).catch(() => {});
  }
  return { ...first, walk };
}

/**
 * What the trip page is filled from.
 *
 * The record holds the journey under the names the rest of the bot uses, and
 * the trip page wants its own. The ticket gives the flight and where the
 * journey began, the visa gives its validity window, and a booking can give
 * the place to stay. Where no booking was sent, the same editable Ho Chi Minh
 * address used by the e-visa application completes the required cascade.
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
    // With no return ticket, the visa's final valid day is the last departure
    // the available documents support. It stays editable on the review.
    departureDate: firstFrom(sources, 'departureDate', 'visaExpiryDate'),
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

/**
 * Sends one page of the declaration as it is finished.
 *
 * A picture of the page and, under it, only what a picture cannot say. The
 * review carries no list at all: it is the site's own summary of everything
 * above it, and a list beside it would say the same thing twice.
 */
async function showThePage({
  ctx,
  chatId,
  page,
  at,
  title,
  result,
  session,
  describeFilled,
  log,
  strings,
  InputFile,
}) {
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
  const said =
    at === 2
      ? strings.arrivalReviewShot
      : `${strings.arrivalPageOf(at + 1, 3, title)}\n\n${describeFilled(
          onThePage,
          result,
          session.language
        )}`;
  if (!shot) {
    await ctx.reply(said, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }
  const fits = said.length <= CAPTION_LIMIT;
  await ctx
    .replyWithPhoto(new InputFile(shot, strings.arrivalShotName), {
      caption: fits ? said : undefined,
      parse_mode: 'HTML',
      show_caption_above_media: true,
    })
    .catch((error) =>
      log(chatId, `the picture did not send: ${error.message}`)
    );
  if (!fits) {
    await ctx.reply(said, { parse_mode: 'HTML' }).catch(() => {});
  }
}

/** Telegram's limit on the words under a picture. */
const CAPTION_LIMIT = 1024;

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
  if (image) {
    held.uploaded = { ...held.uploaded, passportPage: true };
  }
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
  const { sessions, log, showStatus = () => () => {} } = deps;
  return async function refill(ctx, chatId) {
    const held = sessions.get(chatId).arrival;
    // A declaration standing on its review page is filled, not finished: a
    // correction sent now is a correction to what is on it, and the walk
    // starts again from the first page with the new value in hand.
    if (!held || (held.stage !== 'form' && held.stage !== 'review')) {
      return;
    }
    const busy = showStatus(ctx, 'typing');
    try {
      await fillAndShow({ ...deps, ctx, chatId });
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
 * never reaches here on its own — it stops at the review with the box
 * untouched — so nothing files itself while somebody is reading.
 *
 * Everything is said out loud: what is about to happen, and what the site
 * made of it. A filing nobody is told about is one nobody can act on.
 */
export function declarationFiler(deps) {
  const { sessions, log, MESSAGES, showStatus = () => () => {} } = deps;
  return async function file(ctx, chatId) {
    const session = sessions.get(chatId);
    const strings = MESSAGES[session.language];
    const held = session.arrival;
    if (!held || held.stage !== 'review') {
      log(chatId, 'asked to file, but no declaration is on its review page');
      await ctx.reply(strings.arrivalNothingToFile).catch(() => {});
      return false;
    }
    const busy = showStatus(ctx, 'typing');
    try {
      await ctx.reply(strings.arrivalFiling).catch(() => {});
      const out = await fileTheDeclaration(held.page, {
        confirmed: true,
        log: (said) => log(chatId, said),
      });
      if (out.filed) {
        held.stage = 'filed';
        await ctx.reply(strings.arrivalFiled).catch(() => {});
        return true;
      }
      await ctx
        .reply(
          strings.arrivalNotFiled(
            [out.why, ...(out.refused ?? [])].filter(Boolean).join('; ')
          )
        )
        .catch(() => {});
      return false;
    } catch (error) {
      log(chatId, `the declaration did not file: ${error.message}`);
      await ctx.reply(strings.arrivalNotFiled(error.message)).catch(() => {});
      return false;
    } finally {
      busy();
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
    // A code that is accepted is followed by the whole fill, which is the
    // long part. The chat should see that something is happening.
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
  await held.browser.close().catch(() => {});
  return true;
}
