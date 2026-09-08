// evisa-download.mjs
//
// Fetches an application's documents: the filled form, the payment receipt,
// and the visa itself after a grant.
//
// The site keeps these behind its public search page, which asks for the
// application number, the email the application was filed with, the applicant's
// date of birth and a captcha. No account is needed, so nothing has to be
// stored between runs, and the captcha is the only step a person must take:
// a front end shows it and sends back what it reads.
//
// The status is worth as much as the files. An application sits in Processing
// for days, and knowing that is the answer to "is it ready yet" without
// anybody opening a browser.

import fs from 'node:fs';
import path from 'node:path';
import { fillText, fillDate, fillCaptcha } from './evisa-fill.mjs';

export const SEARCH_URL = 'https://evisa.gov.vn/e-visa/search';

/** The text fields the search page asks for, by the id the site gives them. */
const SEARCH_FIELDS = {
  applicationNumber: 'basic_maHoSo',
  email: 'basic_email',
};

/**
 * Opens the search page and puts the application's details on it.
 *
 * The captcha is left for a person: everything else the applicant already
 * gave when the application was filed. The date of birth is readonly and
 * backed by a picker, as it is on the application form itself.
 */
export async function openSearch(page, application) {
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`#${SEARCH_FIELDS.applicationNumber}`, {
    timeout: 60000,
  });
  for (const [key, id] of Object.entries(SEARCH_FIELDS)) {
    if (application[key]) {
      await fillText(page, id, String(application[key]).trim());
    }
  }
  if (application.dateOfBirth) {
    await fillDate(page, 'basic_dateOfBirth', application.dateOfBirth);
  }
}

/**
 * Types the search page's captcha.
 *
 * The page names it exactly as the application form does, so the reader and
 * the refresh that serve the form serve this too.
 */
export async function fillSearchCaptcha(page, code) {
  await fillCaptcha(page, code);
}

/**
 * The statuses the site reports, each mapped to what it means for the
 * applicant.
 *
 * The wording is the site's; the meaning is what a front end says out loud,
 * since "Processing" alone does not tell anyone whether to keep waiting.
 */
export const STATUSES = {
  processing: 'waiting',
  'pending payment': 'unpaid',
  approved: 'granted',
  granted: 'granted',
  rejected: 'refused',
  denied: 'refused',
};

/** What a reported status means, or `unknown` for wording not seen before. */
export function meaningOf(status) {
  const text = String(status ?? '')
    .trim()
    .toLowerCase();
  for (const [wording, meaning] of Object.entries(STATUSES)) {
    if (text.includes(wording)) {
      return meaning;
    }
  }
  return 'unknown';
}

/**
 * Reads the result the search returned.
 *
 * Returns null while the page shows no result, which is the state before the
 * captcha is right and after it is wrong; the notice says which.
 */
export function readResult(page) {
  return page.evaluate(() => {
    const text = (node) => node?.textContent?.trim() ?? null;
    // The result is a grid of labels and values under its own heading.
    const labels = [
      ...document.querySelectorAll(
        'label, .ant-descriptions-item-label, td, div'
      ),
    ];
    const find = (wanted) => {
      const label = labels.find((node) =>
        node.textContent?.trim().toLowerCase().startsWith(wanted)
      );
      if (!label) {
        return null;
      }
      const value =
        label.nextElementSibling ??
        label.parentElement?.querySelector('.ant-descriptions-item-content');
      return text(value);
    };
    const status = find('application status');
    if (!status) {
      return null;
    }
    return {
      fullName: find('full name'),
      applicationNumber: find('app no'),
      passportNumber: find('passport'),
      status,
    };
  });
}

/** The site's complaint about a wrong captcha, or whatever else it said. */
export function readNotice(page) {
  return page.evaluate(() => {
    const notice = document.querySelector(
      '.ant-notification-notice, .ant-message-notice'
    );
    return (
      notice?.textContent
        ?.trim()
        .replace(/^Notification/, '')
        .trim() || null
    );
  });
}

/** Presses Search and waits for the site to answer. */
export async function pressSearch(page) {
  await page.locator('button:has-text("Search")').first().click();
  // Either a result appears or a notice complains; whichever comes first ends
  // the wait, and a slow site ends it by timing out with neither.
  await page
    .waitForFunction(
      () =>
        document.querySelector(
          '.ant-notification-notice, .ant-message-notice'
        ) ||
        [...document.querySelectorAll('label, td, div')].some((node) =>
          node.textContent
            ?.trim()
            .toLowerCase()
            .startsWith('application status')
        ),
      undefined,
      { timeout: 30000 }
    )
    .catch(() => {});
  return { result: await readResult(page), notice: await readNotice(page) };
}

/** The buttons the result offers, by what each one fetches. */
const DOWNLOADS = {
  form: 'Save form',
  receipt: 'Download Receipt',
  visa: 'Download e-Visa',
};

/** Which of the documents the page is currently offering. */
export async function availableDocuments(page) {
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('button')].map((b) => b.innerText.trim())
  );
  return Object.entries(DOWNLOADS)
    .filter(([, label]) => labels.some((seen) => seen.includes(label)))
    .map(([kind]) => kind);
}

/**
 * Presses one of the download buttons and saves what it produces.
 *
 * The site sends the file as a download, so the browser's own download event
 * is what carries it; nothing is fetched separately, and no session has to be
 * reproduced outside the page.
 */
export async function downloadDocument(page, kind, outputDir) {
  const label = DOWNLOADS[kind];
  if (!label) {
    throw new Error(`unknown document: ${kind}`);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const waiting = page.waitForEvent('download', { timeout: 60000 });
  await page.locator(`button:has-text("${label}")`).first().click();
  const download = await waiting;
  const suggested = download.suggestedFilename() || `${kind}.pdf`;
  const target = path.join(outputDir, `${kind}-${suggested}`);
  await download.saveAs(target);
  return { kind, path: target };
}

/**
 * Fetches every document the application currently offers.
 *
 * A failure on one is reported and the rest go on: a receipt that will not
 * download is no reason to leave the form unfetched.
 */
export async function downloadAll(page, outputDir) {
  const saved = [];
  const failed = [];
  for (const kind of await availableDocuments(page)) {
    try {
      saved.push(await downloadDocument(page, kind, outputDir));
    } catch (error) {
      failed.push({ kind, why: error.message });
    }
  }
  return { saved, failed };
}
