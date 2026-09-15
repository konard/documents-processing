// evisa-window.mjs
//
// Where the browser window sits, so it never takes the screen unasked.
//
// A Mac makes a newly launched application the active one, whatever its
// windows are told to do, so a form opening behind still lands in front of
// whatever the applicant was reading.
//
// The window is left visible and the front is handed back to the application
// that had it. Hiding the browser instead does put it out of the way, and it
// also stops the window drawing: a hidden window composites no frames, and
// every screenshot of it times out after thirty seconds with the form sitting
// there filled. Visible but behind is the only arrangement that is both out
// of the way and photographable.
//
// Everything here is a Mac's business and does nothing elsewhere, and anything
// that goes wrong is nothing — a window merely in the wrong place.

/** Runs a line of AppleScript, and shrugs at whatever it says. */
async function osascript(lines) {
  try {
    const { execFile } = await import('node:child_process');
    await new Promise((done) => {
      execFile(
        'osascript',
        lines.flatMap((line) => ['-e', line]),
        () => done()
      );
    });
  } catch {
    // A window in the wrong place is not worth failing an application over.
  }
}

/**
 * Hands the front back to whatever was in it before the browser opened.
 *
 * The application that was frontmost is asked for by name and activated
 * again, so the browser drops behind it without being hidden — its window
 * stays on screen, keeps its page, and can still be photographed.
 */
export async function giveBackTheFront(wasInFront) {
  if (process.platform !== 'darwin' || !wasInFront) {
    return;
  }
  await osascript([
    `tell application "System Events" to if exists (process "${wasInFront}") ` +
      `then set frontmost of process "${wasInFront}" to true`,
  ]);
}

/**
 * Which application is in front, so it can be given the front back after.
 *
 * Asked before the browser opens, since afterwards the answer is the browser.
 */
export async function whatIsInFront() {
  if (process.platform !== 'darwin') {
    return null;
  }
  try {
    const { execFile } = await import('node:child_process');
    return await new Promise((done) => {
      execFile(
        'osascript',
        [
          '-e',
          'tell application "System Events" to get name of first process ' +
            'whose frontmost is true',
        ],
        (failed, out) => done(failed ? null : String(out).trim() || null)
      );
    });
  } catch {
    return null;
  }
}

/** Brings the browser forward, which is what `showBrowser` asks for. */
export async function takeTheFrontBack() {
  if (process.platform !== 'darwin') {
    return;
  }
  await osascript([
    'tell application "System Events" to if exists (process "Chromium") ' +
      'then set frontmost of process "Chromium" to true',
    'tell application "System Events" to if exists ' +
      '(process "Google Chrome for Testing") then set frontmost of ' +
      'process "Google Chrome for Testing" to true',
  ]);
}
