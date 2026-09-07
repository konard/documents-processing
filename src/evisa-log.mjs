// evisa-log.mjs
//
// Diagnostics for the bot, verbose by default.
//
// The bot keeps nothing about an applicant, which makes a fault report hard to
// act on: without a trace there is no way to tell a bad crop from a bad read
// from a field the site refused. These lines fill that gap.
//
// Values are recorded as well as the shape of what happened, because a wrong
// birth date is only diagnosable if the wrong value is visible. That means the
// log holds personal data, so it is written to one file the operator controls
// and never leaves the machine. `EVISA_BOT_DEBUG=0` reduces it to shape alone:
// counts, field names and outcomes, with no values.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** True when values may be written; otherwise field names alone. */
export function valuesAllowed() {
  return process.env.EVISA_BOT_DEBUG !== '0';
}

/** Where the log goes; one file, so an operator can find and delete it. */
export function logPath() {
  return process.env.EVISA_BOT_LOG ?? path.join('/tmp', 'evisa-bot-debug.log');
}

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/**
 * Writes one line, to the console and the log file.
 *
 * A chat is identified by its number alone. That is enough to follow one
 * conversation through the file without recording who it belongs to.
 */
export function log(chatId, message) {
  const line = `${stamp()} [chat ${chatId}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(logPath(), `${line}\n`);
  } catch {
    // A log that cannot be written must not stop the bot.
  }
}

/**
 * Describes a set of field values for the log.
 *
 * With values off, only the field names appear, which still shows what was
 * read and what was missing.
 */
export function describeFields(data) {
  const entries = Object.entries(data ?? {}).filter(([, value]) => value);
  if (entries.length === 0) {
    return 'none';
  }
  return valuesAllowed()
    ? entries.map(([key, value]) => `${key}=${value}`).join(', ')
    : entries.map(([key]) => key).join(', ');
}

/** Notes the log's location and what it holds, once at startup. */
export function announce() {
  const mode = valuesAllowed()
    ? 'values included - this file holds personal data'
    : 'field names only, no values';
  console.log(`Debug log: ${logPath()} (${mode})`);
  console.log('Set EVISA_BOT_DEBUG=0 to log field names without values.');
}

/** How long a kept document stays before the bot removes it. */
export const RETENTION_DAYS = Number(process.env.EVISA_BOT_RETENTION_DAYS ?? 7);

/**
 * Removes debugging documents older than the retention window.
 *
 * A machine left running for weeks holds every document it was sent, since the
 * system only empties its temp directory at boot. This sweep bounds that, and
 * touches nothing outside the directories this bot created.
 */
export function sweepKeptFiles({
  days = RETENTION_DAYS,
  root = os.tmpdir(),
} = {}) {
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    // Only the directories this bot made, so nothing else is ever touched.
    if (!entry.isDirectory() || !/^evisa-(bot|doc|shot)-/.test(entry.name)) {
      continue;
    }
    const full = path.join(root, entry.name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // A directory that vanished or cannot be read is not worth failing over.
    }
  }
  return removed;
}
