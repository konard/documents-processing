// evisa-trace.mjs
//
// A record of an application as it was actually made, in links notation.
//
// The bot fills the form and the applicant finishes it by hand: pays, solves
// a captcha, presses the last button. Automating that last stretch means
// knowing what the steps really are, and the only honest source for that is
// runs that happened. So every run is written down.
//
// What is recorded is the page: which fields it had, what each held, and what
// changed between one moment and the next. A change is kept as what it was
// and what it became, so a run reads as a sequence of edits and can be
// replayed against a fresh form.
//
// The file is links notation written the indented way, one document per
// chat. Indentation is what the notation nests by, so the parens fall away
// and a record reads close to the JSON it describes:
//
//   step form
//     at "2026-09-10T16:38:45.000Z"
//     moment opened
//   field basic_ttcnHo
//     was ""
//     now PLACEHOLDER
//     by bot
//   field basic_ttcdPhuongXa
//     was ""
//     now "NHA TRANG WARD"
//     by bot
//   step review
//     at "2026-09-10T16:41:02.000Z"
//     moment reached
//
// It holds the applicant's own details, so it is kept and swept on the same
// terms as the transcripts and the documents.

import fs from 'node:fs';
import path from 'node:path';

/** The steps an application passes, in the order it passes them. */
export const STEPS = [
  'form',
  'review',
  'captcha',
  'declared',
  'payment',
  'paid',
];

/** Fields whose value is a secret and is recorded only as its shape. */
const NEVER_RECORDED = ['captcha'];

/**
 * Reads every field the page has, by id, with what it holds.
 *
 * A select reports the text it shows, which is what the applicant sees and
 * what a replay has to reproduce; its underlying value is the site's own
 * business. Radios and checkboxes report whether they are set.
 */
export function readPageState(page) {
  return page
    .evaluate(() => {
      const state = {};
      for (const element of document.querySelectorAll('input, textarea')) {
        const id = element.id;
        if (!id) {
          continue;
        }
        if (element.type === 'checkbox' || element.type === 'radio') {
          state[id] = element.checked ? 'on' : 'off';
          continue;
        }
        // An Ant Design select keeps its shown text beside the input, and
        // the input itself is only the box that is typed into.
        const select = element.closest('.ant-select');
        const shown = select?.querySelector('.ant-select-selection-item');
        state[id] = (shown?.innerText ?? element.value ?? '').trim();
      }
      return state;
    })
    .catch(() => ({}));
}

/**
 * What changed between two readings of the page.
 *
 * Returns one entry per field that differs, with what it was and what it
 * became, so a run replays as the list of edits that made it.
 */
export function changesBetween(before = {}, after = {}) {
  const changes = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[id] ?? '';
    const now = after[id] ?? '';
    if (was !== now) {
      changes.push({ id, was, now });
    }
  }
  return changes.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Opens the trace for a run.
 *
 * `notation` is the links-notation module, already loaded. A trace without
 * it stays silent and lets the run go on: a missing record must never stop
 * an application being made.
 */
export function openTrace(directory, { enabled = true, notation = null } = {}) {
  if (enabled) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const fileFor = (chatId) => path.join(directory, `chat-${chatId}.lino`);

  /**
   * A value written so the notation carries it whole.
   *
   * A bare word stands as it is; anything with a space, a colon or a quote in
   * it is quoted, and an empty value is written as a pair of quotes so the
   * line still has two halves. A timestamp needs this: its colons would
   * otherwise end the word early.
   */
  const value = (text) => {
    const body = String(text ?? '');
    if (!body) {
      return '""';
    }
    return /^[\w./@+-]+$/.test(body)
      ? body
      : `"${body.replace(/["\\]/g, '\\$&')}"`;
  };

  /**
   * One record, written indented: a heading, then a line per fact under it.
   *
   * Indentation is what the notation uses for nesting, so the parens fall
   * away and what is left reads like the thing it describes:
   *
   *   field basic_ttcdPhuongXa
   *     was ""
   *     now "NHA TRANG WARD"
   *     by bot
   */
  const record = (heading, facts) =>
    [
      heading,
      ...facts
        .filter(([, said]) => said !== undefined)
        .map(([name, said]) => `  ${name} ${value(said)}`),
    ].join('\n');

  /** Whether there is anywhere to write and anything to write with. */
  const writing = () => enabled && Boolean(notation);

  /** What each chat has had recorded, so a run reads as one document. */
  const put = (chatId, build) => {
    if (!writing()) {
      return;
    }
    try {
      fs.appendFileSync(fileFor(chatId), `${build().join('\n')}\n`);
    } catch {
      // A record that cannot be written must never stop an application.
    }
  };

  return {
    /**
     * Records that an application reached a step, and what the page held
     * when it did.
     */
    step(chatId, step, { moment = 'reached', detail = {} } = {}) {
      put(chatId, () => [
        record(`step ${value(step)}`, [
          ['at', new Date().toISOString()],
          ['moment', moment],
          ...Object.entries(detail),
        ]),
      ]);
    },

    /**
     * Records what changed on the page, and who changed it.
     *
     * `by` is the bot or the applicant: an edit the applicant made by hand
     * in the browser is exactly what an automation of that step has to learn
     * to make for them.
     */
    changes(chatId, changes, by = 'bot') {
      if (!changes.length) {
        return;
      }
      const hidden = (id, value) =>
        NEVER_RECORDED.some((secret) => id.includes(secret))
          ? '(withheld)'
          : value;
      put(chatId, () =>
        changes.map(({ id, was, now }) =>
          record(`field ${value(id)}`, [
            ['was', hidden(id, was)],
            ['now', hidden(id, now)],
            ['by', by],
          ])
        )
      );
    },

    /** Records the page's whole state, as the ground a replay starts from. */
    state(chatId, state, moment = 'start') {
      const entries = Object.entries(state);
      if (!entries.length) {
        return;
      }
      put(chatId, () => [
        record(`state ${value(moment)}`, [
          ['at', new Date().toISOString()],
          ...entries,
        ]),
      ]);
    },

    /** A chat's record, as the text of it. */
    read(chatId) {
      try {
        return fs.readFileSync(fileFor(chatId), 'utf8');
      } catch {
        return '';
      }
    },

    pathFor: fileFor,
  };
}

/**
 * Opens the trace a bot run keeps, beside everything else it stores.
 *
 * The last stretch to payment is done by hand for now, and automating it
 * means knowing what those steps really are. A run that happened is the only
 * honest source for that, so every run is written down and can be replayed.
 */
export function traceFor(storeDirectory, { enabled, notation }) {
  return openTrace(path.join(storeDirectory, 'traces'), { enabled, notation });
}

/** Sweeps the traces and says how many went, for the run's opening lines. */
export function sweepTracesIn(storeDirectory, days) {
  const removed = sweepTraces(path.join(storeDirectory, 'traces'), days);
  if (removed) {
    console.log(`Traces older than ${days} days removed: ${removed}`);
  }
  return removed;
}

/**
 * Records a fill: what the applicant changed by hand since the last one,
 * then what this fill put on the page.
 *
 * Returns the page as it now stands, which is the ground the next fill's
 * comparison is made against.
 */
export async function recordFill(trace, chatId, page, { before, result }) {
  const now = await readPageState(page);
  trace.changes(chatId, changesBetween(before ?? {}, now), 'bot');
  trace.step(chatId, 'form', {
    moment: 'filled',
    detail: { filled: result.filled.length, failed: result.failures.length },
  });
  return now;
}

/**
 * Records the page as the bot found it, and what the applicant did to it by
 * hand since the bot last looked.
 *
 * An edit they made in the browser is exactly what an automation of that
 * step has to learn to make for them, so it is worth as much as the bot's
 * own. Returns the page as found.
 */
export async function recordArrival(trace, chatId, page, last) {
  const found = await readPageState(page);
  if (last) {
    trace.changes(chatId, changesBetween(last, found), 'applicant');
  } else {
    trace.step(chatId, 'form', { moment: 'opened' });
    trace.state(chatId, found, 'start');
  }
  return found;
}

/**
 * Records a step the site took, and the page it left behind.
 *
 * This is the record the last stretch to payment is automated from, so what
 * the page actually did is worth more than what it was expected to do.
 */
export async function recordStep(trace, chatId, page, step, label) {
  trace.step(chatId, step.stage, {
    moment: step.moved ? 'reached' : 'refused',
    detail: {
      pressed: label,
      errors: step.errors.length,
      said: step.notices.join(' | ') || undefined,
    },
  });
  trace.state(chatId, await readPageState(page), step.stage);
}

/**
 * Removes traces past the retention the log keeps.
 *
 * A trace holds the applicant's own details, so it is kept for as long as a
 * defect might be reported against it, and no longer.
 */
export function sweepTraces(directory, days) {
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!/^chat-.*\.lino$/.test(entry.name)) {
      continue;
    }
    const full = path.join(directory, entry.name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { force: true });
        removed += 1;
      }
    } catch {
      // A file that vanished is not worth failing over.
    }
  }
  return removed;
}

/**
 * Reads a trace back as the steps and edits it holds.
 *
 * Enough to replay a run: the steps in order, and for each the edits made
 * before the next one.
 */
export function readTrace(text, notation) {
  if (!text.trim() || !notation) {
    return [];
  }
  try {
    return new notation.Parser().parse(text);
  } catch {
    return [];
  }
}
