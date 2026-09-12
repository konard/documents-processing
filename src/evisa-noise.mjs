// evisa-noise.mjs
//
// Telling the site's own broken furniture apart from a real fault.
//
// evisa.gov.vn ships malformed Content-Security-Policy headers, loads two
// fraud-detection vendors and an analytics tracker that are blocked or
// aborted, and probes for a logged-in account on every page load — which
// answers 401, because the e-visa flow is public and there is no account to
// find. None of it is ours to fix, and none of it has ever explained a
// failure.
//
// Filtering it keeps the log readable: at thousands of lines a day it buries
// the errors that do explain something. The lines are counted, not dropped
// silently, so the volume stays visible.

/** What the site produces on its own account, whatever we do. */
export const SITE_OWN_NOISE = [
  /Content Security Policy directive/i,
  /online-metrix\.net|forter\.com/i,
  /google-analytics\.com|googletagmanager\.com/i,
  /user-service\/user\/get-user-info/i,
];

/** Whether a line is the site's own noise, and so says nothing about us. */
export function isSiteNoise(said) {
  return SITE_OWN_NOISE.some((pattern) => pattern.test(String(said ?? '')));
}

/**
 * Writes what a browser reports to the log: console errors and warnings,
 * script errors, requests that failed and answers of 400 and up.
 *
 * When the site draws a page bare, this is where the reason shows. The
 * site's own noise is only counted, so a real fault stands out among it.
 */
export function watchBrowser(chatId, page, { log, noise }) {
  page.on('console', (message) => {
    if (
      ['error', 'warning'].includes(message.type()) &&
      !noise.filter(chatId, message.text())
    ) {
      log(chatId, `browser console ${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    log(chatId, `browser script error: ${error.message}`);
  });
  page.on('requestfailed', (request) => {
    if (noise.filter(chatId, request.url())) {
      return;
    }
    const why = request.failure()?.errorText ?? '?';
    log(
      chatId,
      `browser request failed: ${request.method()} ${request.url()} (${why})`
    );
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !noise.filter(chatId, response.url())) {
      const method = response.request().method();
      log(
        chatId,
        `browser response ${response.status()}: ${method} ${response.url()}`
      );
    }
  });
}

/**
 * Counts the site's noise per chat, so it can be filtered out of the log
 * and still reported as a number.
 */
export function countNoise() {
  const seen = new Map();
  return {
    /** True if this was noise, which also counts it. */
    filter(chatId, said) {
      if (!isSiteNoise(said)) {
        return false;
      }
      seen.set(chatId, (seen.get(chatId) ?? 0) + 1);
      return true;
    },
    countFor(chatId) {
      return seen.get(chatId) ?? 0;
    },
    forget(chatId) {
      seen.delete(chatId);
    },
  };
}
