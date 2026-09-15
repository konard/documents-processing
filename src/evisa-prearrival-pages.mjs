// evisa-prearrival-pages.mjs
//
// Walking the declaration from the passenger to the review.
//
// The site files a declaration in four steps — Passenger Information, Trip
// Information, Review & Submit, Result — and this walks the first three. The
// fourth belongs to the traveller: it is what the site shows once the
// declaration has been filed, and filing it is not the bot's to do.
//
// This is to the declaration what fillBySection is to the visa application,
// and it keeps the same order: each page is filled and settled before the
// next begins. The caller can capture each state or the page the site refused.
// The visa form is one
// long page with headings; this is four pages with buttons between them, so a
// page here has to be left as well as filled — and the site can refuse that.
//
// It refuses by printing "Please fill in the field above" under each field
// that is holding it up, and by leaving the step marker where it was. Both
// are read: the marker says whether the page turned, and the messages say
// what to tell the traveller when it did not.

import { saidBriefly } from './evisa-messages.mjs';
import { captchaIsUp } from './evisa-prearrival-form.mjs';

/**
 * The steps the site prints across the top, in order.
 *
 * The names are the site's own, and the marker for each is what says where
 * the declaration has got to.
 */
export const STEPS = [
  'Passenger Information',
  'Trip Information',
  'Review & Submit',
  'Result',
];

/** How long to give the site to draw the page after a step is left. */
export const TURN_MS = 15000;

/** A page result for the trace: field names and outcomes, never their values. */
function pageResult(result) {
  const names = (items) => items.map((item) => String(item).split(':')[0]);
  return (
    `${result.filled.length} filled [${names(result.filled).join(', ')}], ` +
    `${result.missing.length} missing [${names(result.missing).join(', ')}], ` +
    `${result.failed.length} failed [${names(result.failed).join(', ')}]`
  );
}

/**
 * Which step the site is showing.
 *
 * The active step is the one whose marker is drawn as active; the ones behind
 * it carry a tick where a number would be. Read from the page: the URL does
 * not change between steps and says nothing about where the form has got to.
 */
export function whichStep(page) {
  return page
    .evaluate(() => {
      const steps = [...document.querySelectorAll('.MuiStep-root')];
      const at = steps.findIndex((step) =>
        step.querySelector('.Mui-active, [class*="Mui-active"]')
      );
      return {
        at,
        titles: steps.map((step) => step.innerText.trim().replace(/\n/g, ' ')),
      };
    })
    .catch(() => ({ at: -1, titles: [] }));
}

/** Whether Submit is waiting for the six-digit code sent by email. */
export function emailVerificationIsUp(page) {
  return Promise.resolve()
    .then(() =>
      page
        .locator('[role=dialog]')
        .filter({ hasText: /Verify your email|6-digit code to your email/i })
        .first()
        .isVisible()
    )
    .catch(() => false);
}

/** Enters the emailed code and reports only a definite result. */
export async function verifyDeclarationEmail(
  page,
  code,
  { settleMs = 3000 } = {}
) {
  const value = String(code ?? '').trim();
  if (!/^\d{6}$/.test(value)) {
    return {
      filed: false,
      emailCode: true,
      why: 'the email code must contain six digits',
    };
  }
  if (!(await emailVerificationIsUp(page))) {
    return {
      filed: false,
      emailCode: false,
      why: 'the email verification dialog is not open',
    };
  }

  const dialog = page
    .locator('[role=dialog]')
    .filter({ hasText: /Verify your email|6-digit code to your email/i })
    .first();
  const inputs = dialog.locator('input');
  const count = await inputs.count();
  if (count >= 6) {
    for (let index = 0; index < 6; index += 1) {
      await inputs.nth(index).fill(value[index]);
    }
  } else if (count === 1) {
    await inputs.first().fill(value);
  } else {
    return {
      filed: false,
      emailCode: true,
      why: 'the email-code fields are unavailable',
    };
  }

  await dialog
    .getByRole('button', { name: /^Verify$/i })
    .first()
    .click({ timeout: TURN_MS });
  if (settleMs > 0) {
    await page.waitForTimeout(settleMs);
  }
  if (await captchaIsUp(page)) {
    return {
      filed: false,
      emailCode: false,
      captcha: true,
      why: 'captcha required',
    };
  }
  if (await emailVerificationIsUp(page)) {
    return {
      filed: false,
      emailCode: true,
      why: 'verification code was refused',
    };
  }
  const now = await whichStep(page);
  return {
    filed: now.at >= 3,
    emailCode: false,
    why: now.at >= 3 ? null : 'the result page did not appear',
  };
}

/**
 * What the site is refusing to accept, in its own words.
 *
 * A page that will not turn prints "Please fill in the field above" under
 * each field holding it up. Those are the fields the traveller has to supply,
 * and the site has already worked out which they are, so the page is asked.
 * What the record was missing is a different question with a different answer.
 */
export function whyItWillNotTurn(page) {
  return page
    .evaluate(() => {
      const said = [];
      for (const note of document.querySelectorAll(
        'p[class*=helperText], [class*=Mui-error]'
      )) {
        const words = note.innerText.trim();
        if (!words || said.includes(words)) {
          continue;
        }
        // The heading above the complaint says which field it is about, since
        // the complaint itself only ever says "the field above".
        let box = note;
        let heading = null;
        for (let up = 0; up < 5 && box; up += 1) {
          box = box.parentElement;
          const label = box?.querySelector('p,label,h6');
          const words = label?.innerText?.trim()?.split('\n')[0];
          if (words && words.length > 3 && !/please/i.test(words)) {
            heading = words;
            break;
          }
        }
        said.push(heading ? `${heading}: ${words}` : words);
      }
      return said;
    })
    .catch(() => []);
}

/**
 * Presses the button that leaves a page, and says whether it turned.
 *
 * The site's answer to a page it will not accept is to stay where it is, so
 * the step marker before and after is what decides this — not whether the
 * click landed, which it always does.
 */
export async function turnTo(page, name, { timeout = TURN_MS } = {}) {
  const was = await whichStep(page);
  if (await captchaIsUp(page)) {
    return { turned: false, at: was.at, refused: [], captcha: true };
  }
  await page
    .getByRole('button', { name: new RegExp(name, 'i') })
    .first()
    .click({ timeout });
  // The page redraws before the marker moves, so this waits for the marker
  // and not for the click.
  await page
    .waitForFunction(
      (before) => {
        const steps = [...document.querySelectorAll('.MuiStep-root')];
        const at = steps.findIndex((step) =>
          step.querySelector('.Mui-active, [class*="Mui-active"]')
        );
        const dialog = document.querySelector?.('[role=dialog]');
        const captcha = /CAPTCHA/i.test(dialog?.innerText ?? '');
        return at !== before || captcha;
      },
      was.at,
      { timeout }
    )
    .catch(() => {});
  const now = await whichStep(page);
  if (await captchaIsUp(page)) {
    return { turned: false, at: now.at, refused: [], captcha: true };
  }
  if (now.at === was.at) {
    return { turned: false, at: now.at, refused: await whyItWillNotTurn(page) };
  }
  return { turned: true, at: now.at, refused: [] };
}

/** Returns an in-progress correction to the first page before refilling it. */
export async function returnToPassenger(page, { log = () => {} } = {}) {
  const current = await whichStep(page);
  if (current.at === 0) {
    return true;
  }
  if (current.at < 0) {
    log('could not tell which declaration page is open');
    return false;
  }
  const returned = await turnTo(page, STEPS[0]);
  if (!returned.turned || returned.at !== 0) {
    log(
      `could not return from page ${current.at + 1} to passenger information`
    );
    return false;
  }
  log(`returned from page ${current.at + 1} to passenger information`);
  return true;
}

/**
 * Walks the declaration from the passenger page to the review.
 *
 * Each page is filled, settled and handed to `onPage` for capture before the
 * next begins. A page the site will not accept ends the walk there, with its
 * own words kept for diagnosis; the chat answer names actionable fields in
 * the traveller's language.
 *
 * Nothing is filed. The walk stops on Review & Submit; the caller may tick
 * its mandatory confirmation box for the screenshot, but only the traveller's
 * later message is allowed to press Submit.
 */
export async function walkTheDeclaration({
  page,
  fillPassenger,
  fillTrip,
  onPage,
  log = () => {},
}) {
  const pages = [];
  const took = async (at, title, result) => {
    pages.push({ at, title, ...result });
    await onPage?.({ at, title, page, ...result }).catch(() => {});
  };

  // Page one: the traveller and the passport, already filled by the caller
  // since it is what the captcha gates and what the passport upload feeds.
  const passenger = await fillPassenger();
  log(`page 1/3 ${STEPS[0]}: ${pageResult(passenger)}`);
  await took(0, STEPS[0], passenger);
  if (passenger.arrival?.tooEarly || passenger.expired) {
    return { pages, reached: 0, stopped: 'the site will not take this date' };
  }
  if (pageNeedsWork(passenger)) {
    log('page 1/3 remains open: required passenger information is missing');
    return { pages, reached: 0, refused: [], stopped: STEPS[0] };
  }

  const toTrip = await turnTo(page, STEPS[1]);
  if (!toTrip.turned) {
    log(
      `page 1/3 would not turn: ${toTrip.refused.join('; ') || 'no reason given'}`
    );
    return { pages, reached: 0, refused: toTrip.refused, stopped: STEPS[0] };
  }
  log(`page 1/3 turned; on ${STEPS[1]}`);

  const trip = await fillTrip();
  log(`page 2/3 ${STEPS[1]}: ${pageResult(trip)}`);
  await took(1, STEPS[1], trip);
  if (pageNeedsWork(trip)) {
    log('page 2/3 remains open: required trip information is missing');
    return { pages, reached: 1, refused: [], stopped: STEPS[1] };
  }

  const toReview = await turnTo(page, STEPS[2]);
  if (!toReview.turned) {
    log(
      `page 2/3 would not turn: ${toReview.refused.join('; ') || 'no reason given'}`
    );
    return { pages, reached: 1, refused: toReview.refused, stopped: STEPS[1] };
  }
  log(`page 2/3 turned; on ${STEPS[2]}`);

  // The review holds nothing to fill: it prints back what the two pages above
  // it hold, for the traveller to check before they file it.
  await took(2, STEPS[2], { filled: [], missing: [], failed: [] });
  return { pages, reached: 2, stopped: null };
}

/** Required information the driver could not put on a page. */
function pageNeedsWork(result = {}) {
  const blockingFailures = (result.failed ?? []).filter(
    (failure) =>
      !/^passportImage:\s*the site read nothing from it$/i.test(
        String(failure).trim()
      )
  );
  return Boolean(result.missing?.length || blockingFailures.length);
}

/**
 * Files the declaration, which is the one thing here nobody does by accident.
 *
 * The review page keeps its Submit behind a box reading "I confirm that the
 * information is correct", and this ticks it and presses the button. It is a
 * real filing with an immigration department about a real person, so it runs
 * only when the traveller has said so in their own words: `confirmed` is that
 * word, and without it nothing is pressed and nothing is ticked.
 *
 * Kept apart from the walk on purpose. A walk that could file at the end is
 * one press away from filing by mistake, and there is no taking it back.
 */
// The branches are the definite gates and outcomes after the irreversible click.
// eslint-disable-next-line complexity
export async function fileTheDeclaration(
  page,
  { confirmed = false, log = () => {} } = {}
) {
  if (confirmed !== true) {
    // Not an error and not a failure: it is the ordinary state of things. The
    // declaration waits, filled, for the person it is about.
    log('not filing: the traveller has not confirmed it');
    return { filed: false, why: 'not confirmed' };
  }
  if (await emailVerificationIsUp(page)) {
    return {
      filed: false,
      why: 'email verification required',
      refused: [],
      emailCode: true,
    };
  }
  const step = await whichStep(page);
  if (step.at >= 3) {
    return { filed: true, why: null, refused: [], alreadyFiled: true };
  }
  if (step.at !== 2) {
    log(`not filing: the form is on step ${step.at + 1}, not the review`);
    return { filed: false, why: 'not on the review page' };
  }
  // Material UI draws its own box over a zero-sized input, so the input is
  // ticked where it will take it and the words beside it are clicked where it
  // will not — the same two ways in that the radios on the pages above need.
  const box = page.getByRole('checkbox').first();
  const ticked = await box
    .check({ force: true, timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!ticked) {
    await page
      .getByText(/I confirm that the information is correct/i)
      .first()
      .click({ timeout: 10000 });
  }
  log('the confirmation box is ticked; filing');
  try {
    await page
      .getByRole('button', { name: /^Submit$/i })
      .first()
      .click({ timeout: TURN_MS });
  } catch (error) {
    if (await captchaIsUp(page)) {
      return {
        filed: false,
        why: 'captcha required',
        refused: [],
        captcha: true,
      };
    }
    throw error;
  }
  await page.waitForTimeout(3000);
  if (await captchaIsUp(page)) {
    return {
      filed: false,
      why: 'captcha required',
      refused: [],
      captcha: true,
    };
  }
  if (await emailVerificationIsUp(page)) {
    return {
      filed: false,
      why: 'email verification required',
      refused: [],
      emailCode: true,
    };
  }
  const now = await whichStep(page);
  const filed = now.at >= 3;
  log(
    filed ? 'the declaration is filed' : 'the site did not move to the result'
  );
  return {
    filed,
    why: filed ? null : 'the site stayed on the review',
    refused: filed ? [] : await whyItWillNotTurn(page),
  };
}

/** What went wrong, said the way a traveller reading a chat would want it. */
export function saidPlainly(error) {
  return saidBriefly(error);
}
