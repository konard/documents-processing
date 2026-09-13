// evisa-keep.mjs
//
// Keeps a chat's collected values between runs of the bot.
//
// These are the values read out of an applicant's documents. Without them a
// restart loses every document they sent, and the next fill finds a record
// with no nationality, which the site needs before it will draw a field.
//
// They are kept apart from the chat store: that file holds a handful of flat
// facts meant to outlive an application, while these are the application
// itself — the applicant's own data, written only where the debug log is
// allowed values, and dropped after the same retention as the documents they
// were read from.

import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 86_400_000;

/**
 * Builds the keeper the session store writes through.
 *
 * `directory` is where the bot keeps its data, `valuesAllowed` decides whether
 * the applicant's data may be written down at all, and `retentionDays` is how
 * long it lives.
 */
export function keepCollectedValues({
  directory,
  valuesAllowed,
  retentionDays,
}) {
  const where = path.join(directory, 'collected');
  const fileFor = (chatId) => path.join(where, `chat-${chatId}.json`);

  const keeper = {
    read(chatId) {
      if (!valuesAllowed()) {
        return {};
      }
      const file = fileFor(chatId);
      try {
        const { at, data } = JSON.parse(fs.readFileSync(file, 'utf8'));
        // Past the retention these are gone, the same as the documents they
        // were read from. The age is checked on the way out as well as by the
        // sweep, so a stale file is never read even before a sweep runs.
        if (!at || Date.now() - Date.parse(at) > retentionDays * DAY_MS) {
          keeper.forget(chatId);
          return {};
        }
        return data ?? {};
      } catch {
        // No file yet, or one that will not parse: either way there is
        // nothing to restore, and a chat with no history is the normal case.
        return {};
      }
    },

    // Written synchronously, since the rename that makes it visible has to
    // be one step, and a few hundred bytes cost nothing. The signature is a
    // promise all the same: the caller awaits a keeper, not this one.
    write(chatId, data) {
      if (!valuesAllowed()) {
        return Promise.resolve();
      }
      fs.mkdirSync(where, { recursive: true, mode: 0o700 });
      const said = JSON.stringify({ at: new Date().toISOString(), data });
      // Written beside the file and moved over it, so a bot killed mid-write
      // leaves the previous values whole.
      const temporary = `${fileFor(chatId)}.writing`;
      fs.writeFileSync(temporary, said, { mode: 0o600 });
      fs.renameSync(temporary, fileFor(chatId));
      return Promise.resolve();
    },

    forget(chatId) {
      fs.rmSync(fileFor(chatId), { force: true });
      fs.rmSync(`${fileFor(chatId)}.writing`, { force: true });
    },

    /** Drops every chat's values past the retention. Returns how many went. */
    sweep(now = Date.now()) {
      let gone = 0;
      if (!fs.existsSync(where)) {
        return gone;
      }
      for (const name of fs.readdirSync(where)) {
        const file = path.join(where, name);
        const age = now - fs.statSync(file).mtimeMs;
        if (age > retentionDays * DAY_MS) {
          fs.rmSync(file, { force: true });
          gone += 1;
        }
      }
      return gone;
    },
  };
  return keeper;
}
