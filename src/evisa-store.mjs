// evisa-store.mjs
//
// What the bot remembers about a chat between runs, in an associative store.
//
// The language an applicant picks, and the application the site registered for
// them, outlive the conversation: a bot that is restarted, or an applicant who
// says /start a day later, must not forget either. Holding them only in memory
// meant /start reverted to whatever language Telegram guessed.
//
// Two layers, as the associative stack describes:
//
//   Links Notation  the durable, readable form on disk. A `.lino` file anybody
//                   can open, diff and repair by hand, which is what makes it
//                   worth keeping personal data in for as short a time as this
//                   does.
//   Doublets        the binary link store, where each link is a source and a
//                   target and every fact is a link between links. It is built
//                   from the notation on load and answers the reads.
//
// A fact here is three links deep: the chat, the property, and the value, held
// as (chat (property value)). Writing one is therefore adding links, and the
// notation is rewritten from the store so the two never drift.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Facts worth keeping; anything else stays in the session and is dropped. */
export const KEPT = ['language', 'applicationNumber', 'applicationEmail'];

/**
 * Loads the doublets store.
 *
 * The package ships a web build that imports its own WebAssembly, which Node
 * declines to load as a module, so the bytes are handed to WebAssembly
 * directly and the bindings are pointed at the result.
 */
async function loadDoublets() {
  const require = createRequire(import.meta.url);
  const bindings = await import('doublets-web/doublets_web_bg.js');
  const bytes = fs.readFileSync(
    require.resolve('doublets-web/doublets_web_bg.wasm')
  );
  const { instance } = await WebAssembly.instantiate(bytes, {
    './doublets_web_bg.js': bindings,
  });
  bindings.__wbg_set_wasm(instance.exports);
  instance.exports.__wbindgen_start?.();
  return bindings;
}

/**
 * A chat's remembered facts, as one document of links notation.
 *
 * Each chat is a link whose values are its properties, so the file reads as
 * the thing it is: which chat, and what is known about it.
 */
export function toNotation(chats) {
  const { Link } = notation();
  const word = (id) => new Link(id, []);
  return [...chats.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(
      ([chatId, facts]) =>
        new Link(null, [
          word('chat'),
          word(String(chatId)),
          ...Object.entries(facts)
            .filter(([, value]) => value !== null && value !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(
              ([name, value]) =>
                new Link(null, [word(name), word(quoted(String(value)))])
            ),
        ])
    );
}

/** A value written so it survives the round trip through the notation. */
function quoted(value) {
  return /^[\w.@+-]+$/.test(value) ? value : `'${value.replace(/'/g, "\\'")}'`;
}

/** The value as it was before quoting. */
function unquoted(value) {
  const text = String(value ?? '');
  return /^'.*'$/.test(text) ? text.slice(1, -1).replace(/\\'/g, "'") : text;
}

/**
 * Reads a parsed notation document back into chats and their facts.
 *
 * Anything the document holds that is not a `(chat <id> ...)` link is passed
 * over: a file somebody has added a note to still loads.
 */
export function fromNotation(document) {
  const chats = new Map();
  for (const link of document ?? []) {
    const values = link.values ?? [];
    if (values[0]?.id !== 'chat' || !values[1]?.id) {
      continue;
    }
    const facts = {};
    for (const property of values.slice(2)) {
      const [name, value] = property.values ?? [];
      if (name?.id && value?.id !== undefined) {
        facts[name.id] = unquoted(value.id);
      }
    }
    chats.set(values[1].id, facts);
  }
  return chats;
}

/**
 * Opens the store kept beside the bot's own data.
 *
 * The notation on disk is the truth on load; the doublets store is built from
 * it and holds the same facts as links while the bot runs. A write updates
 * both, and the file is replaced atomically, so a bot killed mid-write leaves
 * the previous file intact.
 */
export async function openStore(directory, { fileName = 'chats.lino' } = {}) {
  const file = path.join(directory, fileName);
  fs.mkdirSync(directory, { recursive: true });

  const chats = readFile(file);
  let doublets = await buildDoublets(chats).catch(() => null);

  const save = async () => {
    const { formatLinks } = notation();
    const text = `${formatLinks(toNotation(chats))}\n`;
    // Written beside the file and moved over it, so a bot killed mid-write
    // leaves the previous file whole.
    const temporary = `${file}.writing`;
    fs.writeFileSync(temporary, text);
    fs.renameSync(temporary, file);
    // The binary store holds the same facts, so it is rebuilt from them.
    doublets = await buildDoublets(chats).catch(() => null);
  };

  return {
    /** Everything remembered about a chat. */
    get(chatId) {
      return { ...(chats.get(String(chatId)) ?? {}) };
    },
    /** One remembered fact, or null when it was never written. */
    read(chatId, name) {
      return chats.get(String(chatId))?.[name] ?? null;
    },
    /** Remembers a fact, and writes the file. */
    async write(chatId, name, value) {
      const key = String(chatId);
      const facts = chats.get(key) ?? {};
      if (value === null || value === undefined) {
        delete facts[name];
      } else {
        facts[name] = String(value);
      }
      chats.set(key, facts);
      await save();
    },
    /** Forgets a chat entirely, which is what /reset means here. */
    async forget(chatId) {
      chats.delete(String(chatId));
      await save();
    },
    /** How many links the binary store holds, or null when it is absent. */
    linkCount() {
      return doublets ? doublets.links.count(null) : null;
    },
    get path() {
      return file;
    },
  };
}

/** The notation parser and formatter, loaded once. */
let notationModule = null;
function notation() {
  if (!notationModule) {
    throw new Error('the links notation module was not loaded');
  }
  return notationModule;
}

/** Reads the file into chats, treating an unreadable one as empty. */
function readFile(file) {
  if (!fs.existsSync(file)) {
    return new Map();
  }
  try {
    const { Parser } = notation();
    return fromNotation(new Parser().parse(fs.readFileSync(file, 'utf8')));
  } catch {
    // A file that will not parse is kept where it is and passed over, so a
    // broken write never costs the applicant their conversation.
    return new Map();
  }
}

/**
 * Builds the binary store from the facts just read.
 *
 * Every distinct word — a chat's id, a property's name, a value — becomes a
 * point, a link standing for itself, and a fact becomes a link from the chat
 * to a link joining the property to its value. So `(chat 42 (language ru))`
 * is four points and two links, and the same knowledge that the file holds as
 * text is addressable here as links.
 */
async function buildDoublets(chats) {
  const bindings = await loadDoublets();
  const links = new bindings.UnitedLinks();
  const points = new Map();
  // A word is one point however often it appears, so two chats in the same
  // language share the link that stands for that language.
  const point = (word) => {
    if (!points.has(word)) {
      const id = links.create();
      links.update(id, id, id);
      points.set(word, id);
    }
    return points.get(word);
  };
  const pair = (from, to) => {
    const id = links.create();
    links.update(id, from, to);
    return id;
  };

  for (const [chatId, facts] of chats) {
    const chat = point(`chat:${chatId}`);
    for (const [name, value] of Object.entries(facts)) {
      pair(chat, pair(point(name), point(`${name}:${value}`)));
    }
  }
  return { bindings, links, points };
}

/** Loads the notation module, which every other call needs. */
export async function prepareStore() {
  notationModule ??= await import('links-notation');
  return notationModule;
}
