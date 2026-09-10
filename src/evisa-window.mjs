// evisa-window.mjs
//
// Where the browser window sits, so it never takes the screen unasked.
//
// A Mac makes a newly launched application the active one, whatever its
// windows are told to do, so a form opening behind still lands in front of
// whatever the applicant was reading. Asking the window server to put the
// browser behind settles it: the window stays open and keeps its page.
//
// Everything here is a Mac's business and does nothing elsewhere, and
// anything that goes wrong is nothing — a window merely in the wrong place.

/**
 * Hands the front back to whatever was in it before the browser opened.
 *
 * A Mac makes a newly launched application the active one, so the window
 * appears over whatever the applicant was reading even though it was told to
 * open behind. Asking the window server to hide the browser is enough: the
 * window stays open and keeps its page, and `showBrowser` brings it back when
 * the form is worth looking at.
 *
 * Anything that goes wrong here is nothing: the window is merely in front.
 */
export async function giveBackTheFront() {
  if (process.platform !== 'darwin') {
    return;
  }
  try {
    const { execFile } = await import('node:child_process');
    await new Promise((done) => {
      // Named, so it is the browser that goes behind and never whatever the
      // applicant happens to be in front of.
      execFile(
        'osascript',
        [
          '-e',
          'tell application "System Events" to if exists (process "Chromium") ' +
            'then set visible of process "Chromium" to false',
          '-e',
          'tell application "System Events" to if exists ' +
            '(process "Google Chrome for Testing") then set visible of ' +
            'process "Google Chrome for Testing" to false',
        ],
        () => done()
      );
    });
  } catch {
    // A window in front is not worth failing an application over.
  }
}

/** Undoes `giveBackTheFront`, so the window can be raised again. */
export async function takeTheFrontBack() {
  if (process.platform !== 'darwin') {
    return;
  }
  try {
    const { execFile } = await import('node:child_process');
    await new Promise((done) => {
      execFile(
        'osascript',
        [
          '-e',
          'tell application "System Events" to if exists (process "Chromium") ' +
            'then set visible of process "Chromium" to true',
          '-e',
          'tell application "System Events" to if exists ' +
            '(process "Google Chrome for Testing") then set visible of ' +
            'process "Google Chrome for Testing" to true',
        ],
        () => done()
      );
    });
  } catch {
    // The window is still there to be clicked on either way.
  }
}
