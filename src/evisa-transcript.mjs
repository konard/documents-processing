// evisa-transcript.mjs
//
// Every message of a conversation, both sides of it, written down as it
// happens.
//
// The debug log says what the bot did; it did not say what either party said.
// Diagnosing a defect from it meant asking the applicant to describe what they
// had seen, and screenshots of a chat are a poor substitute for the text. A
// transcript makes the next session start from the record.
//
// One file per chat, a line per message, JSON so it can be read by eye and by
// program. Files an applicant sent are copied beside it under their own names,
// so a passport that failed to read can be read again.

import fs from 'node:fs';
import path from 'node:path';

/** What a caption or a body is cut to in the transcript. */
const LONGEST = 4000;

/**
 * Opens the transcript for a run.
 *
 * `directory` holds one file per chat. Nothing is written when the log is set
 * to withhold values, since a transcript is the values.
 */
export function openTranscript(directory, { enabled = true } = {}) {
  if (enabled) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const fileFor = (chatId) => path.join(directory, `chat-${chatId}.jsonl`);

  const put = (chatId, entry) => {
    if (!enabled) {
      return;
    }
    try {
      fs.appendFileSync(
        fileFor(chatId),
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`
      );
    } catch {
      // A transcript that cannot be written must never stop a conversation.
    }
  };

  return {
    /** Records what the applicant sent. */
    fromApplicant(chatId, message) {
      put(chatId, { from: 'applicant', ...describeIncoming(message) });
    },
    /** Records what the bot sent back. */
    fromBot(chatId, method, payload) {
      put(chatId, { from: 'bot', ...describeOutgoing(method, payload) });
    },
    /** Keeps a copy of a file the applicant sent, beside the transcript. */
    keepFile(chatId, buffer, name) {
      if (!enabled) {
        return null;
      }
      try {
        const dir = path.join(directory, `chat-${chatId}-files`);
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = path.join(dir, `${stamp}-${name}`);
        fs.writeFileSync(target, buffer);
        return target;
      } catch {
        return null;
      }
    },
    /** Where a chat's transcript is, for a log line that points at it. */
    pathFor: fileFor,
  };
}

/** What arrived, in the shape the transcript keeps. */
export function describeIncoming(message = {}) {
  const entry = { kind: 'text' };
  if (message.text) {
    entry.text = cut(message.text);
  }
  if (message.caption) {
    entry.caption = cut(message.caption);
  }
  if (message.photo) {
    entry.kind = 'photo';
    // Telegram sends several sizes; the last is the largest.
    const largest = message.photo[message.photo.length - 1];
    entry.file = { id: largest?.file_id, bytes: largest?.file_size };
  }
  if (message.document) {
    entry.kind = 'document';
    entry.file = {
      id: message.document.file_id,
      name: message.document.file_name,
      bytes: message.document.file_size,
    };
  }
  return entry;
}

/** What the bot sent, in the shape the transcript keeps. */
export function describeOutgoing(method, payload = {}) {
  const entry = { kind: method.replace(/^send/, '').toLowerCase() || method };
  if (payload.text) {
    entry.text = cut(payload.text);
  }
  if (payload.caption) {
    entry.caption = cut(payload.caption);
  }
  // A file goes out as a stream, so the transcript keeps its name only.
  for (const key of ['photo', 'document', 'video']) {
    if (payload[key]) {
      entry.file = { as: key, name: payload[key]?.filename ?? null };
    }
  }
  if (payload.reply_markup?.inline_keyboard) {
    entry.buttons = payload.reply_markup.inline_keyboard
      .flat()
      .map((button) => button.text);
  }
  return entry;
}

/** A body cut to a length a transcript line can carry. */
function cut(text) {
  const body = String(text);
  return body.length > LONGEST ? `${body.slice(0, LONGEST)}…` : body;
}

/**
 * Reads a chat's transcript back.
 *
 * A line that will not parse is passed over: a file half-written when the bot
 * was killed still gives up everything before that point.
 */
export function readTranscript(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** The conversation as a person would read it. */
export function renderTranscript(entries) {
  return entries
    .map((entry) => {
      const who = entry.from === 'applicant' ? '←' : '→';
      const body =
        entry.text ??
        entry.caption ??
        (entry.file
          ? `[${entry.kind}: ${entry.file.name ?? entry.file.id}]`
          : `[${entry.kind}]`);
      const buttons = entry.buttons?.length
        ? ` [buttons: ${entry.buttons.join(', ')}]`
        : '';
      return `${entry.at} ${who} ${body}${buttons}`;
    })
    .join('\n');
}

/**
 * Removes transcripts and their files past the retention the log keeps.
 *
 * A transcript is the applicant's own conversation: their passport details,
 * their address, their telephone number. It is worth keeping for as long as a
 * defect might be reported against it, and no longer.
 */
export function sweepTranscripts(directory, days) {
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!/^chat-/.test(entry.name)) {
      continue;
    }
    const full = path.join(directory, entry.name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // A file that vanished is not worth failing over.
    }
  }
  return removed;
}

/**
 * Hooks a bot so every message, either way, reaches the transcript.
 *
 * Both sides pass through one place each: grammy's api transformer for what
 * the bot sends, and a middleware for what arrives. Nothing said can go
 * unrecorded by being sent from somewhere new.
 */
export function recordConversations(bot, storeDirectory, enabled) {
  const transcript = openTranscript(path.join(storeDirectory, 'transcripts'), {
    enabled,
  });
  bot.api.config.use((previous, method, payload, signal) => {
    const chatId = payload?.chat_id;
    // The typing indicator is sent every three seconds and says nothing.
    if (chatId && method !== 'sendChatAction') {
      transcript.fromBot(chatId, method, payload);
    }
    return previous(method, payload, signal);
  });
  bot.use(async (ctx, next) => {
    if (ctx.chat?.id && ctx.message) {
      transcript.fromApplicant(ctx.chat.id, ctx.message);
    }
    await next();
  });
  return transcript;
}
