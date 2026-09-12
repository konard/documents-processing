// evisa-documents.mjs
//
// What happens to an application after the site accepts it: the details it
// hands back, the payment that follows, and the documents that come of it.
//
// The registration dialog is the only place the electronic document code ever
// appears in the browser, and it goes as soon as the applicant presses
// Confirm. Reading it there means the applicant never has to copy the code out
// of a chat to fetch what they paid for.
//
// The parts that touch the bot's own state — its sessions, its browsers, its
// log — are passed in, so this file holds the sequence and not the plumbing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MESSAGES, looksLikeCaptcha } from './evisa-bot.mjs';
import { refreshCaptcha } from './evisa-fill.mjs';

/** How often the browser is asked whether the payment has gone through. */
const PAYMENT_POLL_MS = 60_000;

/** How long to keep watching before leaving it to the applicant. */
const PAYMENT_WATCH_MS = 60 * 60 * 1000;

/**
 * A page of its own for looking applications up.
 *
 * The application form lives on the chat's own page, half filled and waiting
 * on its applicant. Navigating that page to the search would throw the form
 * away, so a lookup gets a second tab in the same browser, kept for as long
 * as the lookups go on and closed with the browser.
 */
async function lookupPageFor(
  chatId,
  { browsers, log, pageFor, logBrowserEvents }
) {
  const held = browsers.get(chatId);
  if (held?.lookup && !held.lookup.isClosed()) {
    return held.lookup;
  }
  // Opening the form's page first gives the browser to put the tab in.
  await pageFor(chatId);
  const opened = browsers.get(chatId);
  opened.lookup = await opened.browser.newPage();
  logBrowserEvents(chatId, opened.lookup);
  log(chatId, 'opened a second tab for the lookup');
  return opened.lookup;
}

/**
 * Types the captcha into the search page, then saves whatever the result
 * offers: the filled form, the receipt, and the visa after a grant.
 *
 * A wrong code leaves the page where it was, and the site says so; another
 * captcha is then asked for, as on the application form.
 */
async function fetchDocuments(ctx, chatId, code, deps) {
  const { sessions, browsers, log, pageFor, logBrowserEvents, InputFile } =
    deps;
  const session = sessions.get(chatId);
  const strings = MESSAGES[session.language];
  const page = await lookupPageFor(chatId, {
    browsers,
    log,
    pageFor,
    logBrowserEvents,
  });
  const {
    fillSearchCaptcha,
    pressSearch,
    downloadAll,
    meaningOf,
    describeSearchPage,
  } = await import('./evisa-download.mjs');
  await fillSearchCaptcha(page, code);
  const { result, notice } = await pressSearch(page);
  if (!result) {
    // Nothing read is either a search that never ran or one whose result was
    // not recognised, and from the outside they look alike. The page itself
    // says which: the buttons that fetch the documents are only there when
    // an application was found.
    const showing = await describeSearchPage(page).catch(() => null);
    log(
      chatId,
      `search returned nothing${notice ? `: ${notice}` : ''}${
        showing
          ? `; the page shows buttons [${showing.buttons.join(', ')}] and ` +
            `labels [${showing.labels.join(' | ')}]`
          : ''
      }`
    );
    await ctx.reply(notice ? strings.siteSaid(notice) : strings.documentsNone);
    await refreshCaptcha(page);
    await deps.askCaptcha(ctx, chatId, strings.captchaAgain, page);
    return;
  }
  session.lookingUp = null;
  log(chatId, `application status: ${result.status}`);
  await ctx.reply(
    strings.applicationStatus(result.status, meaningOf(result.status))
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-docs-'));
  try {
    const { saved, failed } = await downloadAll(page, dir);
    for (const file of saved) {
      await ctx.replyWithDocument(
        new InputFile(file.path, path.basename(file.path))
      );
    }
    log(chatId, `saved ${saved.length}, failed ${failed.length}`);
    if (!saved.length) {
      await ctx.reply(strings.documentsNotReady);
    }
  } finally {
    // The files hold the applicant's own documents; the chat now has them.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Builds the after-the-application steps against a bot's own state.
 *
 * Everything the sequence needs and cannot own — the sessions, the open
 * browsers, the log, the file sender — arrives here once, so each step below
 * reads as a description of what it does.
 */
export function createDocuments({
  sessions,
  browsers,
  store,
  log,
  shown,
  askCaptcha,
  pageFor,
  logBrowserEvents,
  InputFile,
}) {
  /**
   * Keeps what the registration dialog says, and starts watching for payment.
   *
   * That dialog is the only place the electronic document code appears, and it
   * goes when the applicant presses Confirm. Read now, the code and the details
   * beside it are enough to look the application up later without the applicant
   * copying anything out of the chat.
   */
  async function keepRegistration(ctx, chatId, step) {
    const session = sessions.get(chatId);
    const strings = MESSAGES[session.language];
    const { readRegistration, canLookUp } =
      await import('./evisa-download.mjs');
    const details = readRegistration(step.dialog?.lines ?? []);
    if (!details.applicationNumber) {
      log(chatId, 'the registration dialog carried no application number');
      return;
    }
    // What the applicant already told the bot fills whatever the dialog left
    // out, so a lookup has all three answers the search page asks for.
    session.application = {
      email: session.data?.email,
      dateOfBirth: session.data?.dateOfBirth,
      ...details,
      registeredAt: Date.now(),
    };
    log(chatId, `application registered: ${shown(details.applicationNumber)}`);
    // The number outlives the conversation: a restart must not cost the
    // applicant the one key their documents are fetched by.
    await store?.write(chatId, 'applicationNumber', details.applicationNumber);
    if (session.application.email) {
      await store?.write(chatId, 'applicationEmail', session.application.email);
    }
    await ctx.reply(strings.applicationKept(details.applicationNumber));
    if (canLookUp(session.application)) {
      watchForPayment(ctx, chatId);
    }
  }

  /**
   * Watches the applicant's own browser for the payment going through.
   *
   * Payment happens in that window, on the bank's pages, and the site draws
   * one of its own pages at the end. Watching for that lets the
   * documents be offered the moment they exist, with nobody having to come
   * back and ask.
   */
  function watchForPayment(ctx, chatId) {
    const session = sessions.get(chatId);
    if (session.paymentWatch) {
      return;
    }
    const until = Date.now() + PAYMENT_WATCH_MS;
    log(chatId, 'watching the browser for the payment');
    session.paymentWatch = setInterval(async () => {
      const held = browsers.get(chatId);
      if (!held || Date.now() > until) {
        stopWatchingPayment(chatId);
        return;
      }
      try {
        const url = held.page.url();
        if (!/payment-success|payment-result|thanh-toan/i.test(url)) {
          return;
        }
        log(chatId, `the browser reached ${url}; the payment went through`);
        stopWatchingPayment(chatId);
        await ctx.reply(MESSAGES[session.language].paymentSeen);
        await fetchAfterPayment(ctx, chatId);
      } catch (error) {
        log(chatId, `could not read the browser's page: ${error.message}`);
        stopWatchingPayment(chatId);
      }
    }, PAYMENT_POLL_MS);
    session.paymentWatch.unref?.();
  }

  /** Ends a chat's payment watch, however it ended. */
  function stopWatchingPayment(chatId) {
    const session = sessions.get(chatId);
    if (session.paymentWatch) {
      clearInterval(session.paymentWatch);
      session.paymentWatch = null;
    }
  }

  /**
   * Offers the documents after a successful payment.
   *
   * The lookup still needs its captcha, so this opens the search on the
   * registered application and asks for the code, which is the one
   * thing a person must supply.
   */
  async function fetchAfterPayment(ctx, chatId) {
    const session = sessions.get(chatId);
    const number = session.application?.applicationNumber;
    if (!number) {
      return;
    }
    await lookUpApplication(ctx, chatId, number).catch((error) =>
      log(chatId, `could not open the lookup after payment: ${error.message}`)
    );
  }

  /**
   * Opens the site's search page on an application and asks for its captcha.
   *
   * The search needs the number, the email the application was filed with and
   * the applicant's date of birth. After a payment all three are in the
   * session; asked cold they are gathered first and handed in as `given`,
   * since a search opened without them cannot succeed.
   */
  async function lookUpApplication(ctx, chatId, number, given = {}) {
    const session = sessions.get(chatId);
    const strings = MESSAGES[session.language];
    const page = await lookupPageFor(chatId, {
      browsers,
      log,
      pageFor,
      logBrowserEvents,
    });
    const { openSearch } = await import('./evisa-download.mjs');
    const known = session.application ?? {
      email: store?.read(chatId, 'applicationEmail'),
    };
    await openSearch(page, {
      applicationNumber: number,
      email: given.email ?? known.email ?? session.data?.email,
      dateOfBirth:
        given.dateOfBirth ?? known.dateOfBirth ?? session.data?.dateOfBirth,
    });
    session.lookingUp = number;
    // Its own wording: the form's captcha says the application is about to
    // be filed, which is not what a lookup does.
    if (!(await askCaptcha(ctx, chatId, strings.lookupCaptchaAsk, page))) {
      await ctx.reply(strings.documentsNoCaptcha);
    }
  }

  /**
   * Takes a code as the lookup's captcha when a lookup is waiting on one.
   *
   * Reports whether it did, so the caller can stop: the application form is
   * untouched by any of this.
   */
  function tookLookupCaptcha(ctx, chatId, session) {
    if (!session.lookingUp || !looksLikeCaptcha(ctx.message.text)) {
      return false;
    }
    log(chatId, 'captcha code received for the document lookup');
    fetchDocuments(ctx, chatId, ctx.message.text, {
      sessions,
      browsers,
      log,
      pageFor,
      logBrowserEvents,
      InputFile,
      askCaptcha,
    }).catch((error) =>
      log(chatId, `the document lookup failed: ${error.message}`)
    );
    return true;
  }

  return {
    keepRegistration,
    watchForPayment,
    stopWatchingPayment,
    lookUpApplication,
    fetchDocuments,
    tookLookupCaptcha,
  };
}

/**
 * Says which fields will not take their value, once.
 *
 * A field the site refuses stays refused however many times it is written, so
 * the form is not filled or sent again over it: the applicant is told which
 * field and what was tried, and nothing else happens until they answer.
 */
export async function tellWhatIsStuck({
  ctx,
  session,
  strings,
  result,
  // What a field is called to the applicant. Its name in the code means
  // nothing to them, and a list of forty of them means less than nothing.
  labelFor = (field) => field,
  most = 6,
}) {
  if (session.toldWhatIsStuck) {
    return;
  }
  session.toldWhatIsStuck = true;
  const stuck = result.failures.map((failure) => labelFor(failure.field));
  const named = stuck.slice(0, most);
  const rest = stuck.length - named.length;
  await ctx
    .reply(
      stuck.length ? strings.fieldStuck(named, rest) : strings.nothingChanged
    )
    .catch(() => {});
}

/**
 * Takes a passport's reading into the chat's data and its page for upload.
 *
 * The zone's fields replace whatever was held; the printed side's only fill
 * gaps, since a value the applicant typed is surer than a reading of print
 * over a pattern.
 */
export function keepPassport(
  session,
  read,
  extension,
  { PRINTED_SIDE, keepForUpload }
) {
  for (const [key, value] of Object.entries(read.data)) {
    if (PRINTED_SIDE.includes(key)) {
      session.data[key] ??= value;
    } else {
      session.data[key] = value;
    }
  }
  // A field the engines split on is not put on the form: the candidates
  // are kept, and the summary asks the applicant which is right.
  session.disputed = {};
  for (const { field, candidates } of read.disputed ?? []) {
    session.disputed[field] = candidates.map((c) => c.value);
    delete session.data[field];
  }
  session.uploads.passportPage = keepForUpload(
    read.prepared.path,
    `passport${extension}`
  );
}

/**
 * Keeps an image with no passport in it as the portrait, which is the other
 * image the form wants and needs no reading.
 *
 * The prepared copy is the file as sent when it fits the site's 2 MB limit,
 * and a shrunk one when it does not, as a camera original sent as a file
 * would not.
 */
export function keepPortrait(
  chatId,
  session,
  read,
  local,
  extension,
  { log, keepForUpload }
) {
  const portrait = read?.prepared?.path ?? local;
  if (read?.prepared && !read.prepared.unchanged) {
    log(
      chatId,
      `portrait shrunk to ${Math.round(read.prepared.bytes / 1024)} KB`
    );
  }
  session.uploads.portraitPhoto = keepForUpload(
    portrait,
    `portrait${extension}`
  );
}
