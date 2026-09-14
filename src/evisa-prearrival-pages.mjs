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
// and it keeps the same promise: each page is filled, settled and shown
// before the next is begun, so the chat watches the declaration fill in the
// order it is actually being filled. The difference is that the visa form is
// one long page with headings and this is four pages with buttons between
// them, so a page here has to be left as well as filled — and the site can
// refuse to let it be left.
//
// It refuses by printing "Please fill in the field above" under each field
// that is holding it up, and by leaving the step marker where it was. Both
// are read: the marker says whether the page turned, and the messages say
// what to tell the traveller when it did not.

import { saidBriefly } from './evisa-messages.mjs';

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
        return at !== before;
      },
      was.at,
      { timeout }
    )
    .catch(() => {});
  const now = await whichStep(page);
  if (now.at === was.at) {
    return { turned: false, at: now.at, refused: await whyItWillNotTurn(page) };
  }
  return { turned: true, at: now.at, refused: [] };
}

/**
 * Walks the declaration from the passenger page to the review.
 *
 * Each page is filled, settled and handed to `onPage` before the next is
 * begun. A page the site will not accept ends the walk there, with its own
 * words about what is missing: going on would mean filling a page nobody can
 * reach, and the traveller has something to do before it is worth trying
 * again.
 *
 * Nothing is filed. The walk stops on Review & Submit with the confirmation
 * box untouched, because the last press on a declaration to an immigration
 * department belongs to the person it describes.
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
  log(
    `page 1/3 ${STEPS[0]}: ${passenger.filled.length} filled, ` +
      `${passenger.missing.length} missing, ${passenger.failed.length} failed`
  );
  await took(0, STEPS[0], passenger);
  if (passenger.arrival?.tooEarly || passenger.expired) {
    return { pages, reached: 0, stopped: 'the site will not take this date' };
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
  log(
    `page 2/3 ${STEPS[1]}: ${trip.filled.length} filled, ` +
      `${trip.missing.length} missing, ${trip.failed.length} failed`
  );
  await took(1, STEPS[1], trip);

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
  const step = await whichStep(page);
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
  await page
    .getByRole('button', { name: /^Submit$/i })
    .first()
    .click({ timeout: TURN_MS });
  await page.waitForTimeout(3000);
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
