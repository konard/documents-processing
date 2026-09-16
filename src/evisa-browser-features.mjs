// evisa-browser-features.mjs
//
// The application still uses Playwright directly for site-specific controls,
// but Browser Commander owns the concerns that should not be reimplemented by
// every browser workflow: persistent downloads and portable diagnostic traces.

import {
  createDownloadManager,
  makeBrowserCommander,
  TRACE_MODE,
  writeTraceViewer,
} from 'browser-commander';

/** Browser Commander version written into every trace manifest. */
export const BROWSER_COMMANDER_VERSION = '0.19.0';

/** Features attached to a live Playwright page. */
const attached = new WeakMap();

/** Credential controls excluded from form diagnostics. */
const SECRET_CONTROLS = Object.freeze([
  'input[autocomplete="one-time-code"]',
  'input[name*="captcha" i]',
  'input[id*="captcha" i]',
  'input[placeholder*="captcha" i]',
]);

function newState(
  page,
  commanderFactory,
  viewerWriter,
  downloadManagerFactory
) {
  const commander = commanderFactory({
    page,
    verbose: false,
    // The declaration has its own native-dialog policy. A diagnostic layer
    // must observe that policy, never replace it with automatic dismissal.
    enableDialogManager: false,
  });
  const state = {
    commander,
    downloads: null,
    trace: null,
    stopping: null,
    viewerWriter,
    downloadManagerFactory,
    page,
  };
  attached.set(page, state);
  page.once?.('close', () => {
    // An unexpected close still finalizes every record that can be finalized.
    // The caller cannot await an event listener, so the cleanup is deliberately
    // best-effort here; ordinary closes call stopBrowserFeatures first.
    void stopBrowserFeatures(page).catch(() => {});
  });
  return state;
}

function stateFor(
  page,
  commanderFactory = makeBrowserCommander,
  viewerWriter = writeTraceViewer,
  downloadManagerFactory = createDownloadManager
) {
  return (
    attached.get(page) ??
    newState(page, commanderFactory, viewerWriter, downloadManagerFactory)
  );
}

async function configureDownloads(state, directory) {
  await state.downloads?.dispose?.();
  state.downloads = await state.downloadManagerFactory({
    engine: 'playwright',
    // This context sees automated and human-started downloads in the app.
    // The 0.19 CDP source still targets the wrong Chromium context (#97).
    context: state.page.context(),
    directory,
    persist: true,
    conflict: 'rename',
  });
  state.commander.downloads = state.downloads;
  return state.downloads;
}

function linksPath(traceOutput) {
  return traceOutput.endsWith('.bc-trace')
    ? `${traceOutput.slice(0, -'.bc-trace'.length)}.lino`
    : `${traceOutput}.lino`;
}

/**
 * Attach Browser Commander facilities to a Playwright page.
 *
 * Attach immediately after creating a page to observe its navigation. A named
 * checkpoint on the first useful document provides the full base snapshot.
 */
export async function attachBrowserFeatures(
  page,
  {
    downloadsDirectory = null,
    traceOutput = null,
    commanderFactory = makeBrowserCommander,
    viewerWriter = writeTraceViewer,
    downloadManagerFactory = createDownloadManager,
  } = {}
) {
  const state = stateFor(
    page,
    commanderFactory,
    viewerWriter,
    downloadManagerFactory
  );

  if (downloadsDirectory && !state.downloads) {
    await configureDownloads(state, downloadsDirectory);
  }

  if (traceOutput && !state.trace) {
    state.trace = await state.commander.startTrace({
      output: traceOutput,
      mode: TRACE_MODE.CONTINUOUS,
      initialCheckpoint: 'browser-attached',
      links: {
        output: linksPath(traceOutput),
        include: ['trace', 'timeline', 'checkpoints', 'control-diffs'],
      },
      screenshots: 'checkpoints',
      dom: {
        html: true,
        liveControlState: true,
        mutations: true,
        openShadowRoots: true,
      },
      privacy: { redactSelectors: SECRET_CONTROLS },
      commanderVersion: BROWSER_COMMANDER_VERSION,
    });
  }

  return state;
}

/** Ensure a page has the managed-download lifecycle before a button is hit. */
export async function ensureManagedDownloads(page, directory) {
  const state = stateFor(page);
  if (state.downloads?.directory === directory) {
    return state.downloads;
  }
  return await configureDownloads(state, directory);
}

/** The manager that sees automated and manually initiated downloads. */
export function managedDownloads(page) {
  return attached.get(page)?.downloads ?? null;
}

/** Capture one complete, named recovery point in the portable trace. */
export async function checkpointBrowser(
  page,
  name,
  { actor = 'automation', reason = 'checkpoint' } = {}
) {
  const state = attached.get(page);
  if (!state?.trace) {
    return null;
  }
  const entry = await state.trace.checkpoint(name, { actor, reason });
  return entry;
}

/** Finish the trace and detach observers before its page/browser is closed. */
export async function stopBrowserFeatures(page) {
  const state = attached.get(page);
  if (!state) {
    return null;
  }
  if (state.stopping) {
    return state.stopping;
  }

  state.stopping = (async () => {
    let result = null;
    try {
      result = await state.trace?.stop();
      if (result?.path) {
        // A diagnostic viewer must never keep the user's browser open if its
        // own rendering fails; the raw bundle remains readable either way.
        await state.viewerWriter(result.path).catch(() => {});
      }
    } finally {
      await state.commander.destroy?.().catch(() => {});
      attached.delete(page);
    }
    return result;
  })();
  return await state.stopping;
}
