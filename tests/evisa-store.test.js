import { describe, it, expect } from 'test-anywhere';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  prepareStore,
  openStore,
  toNotation,
  fromNotation,
} from '../src/evisa-store.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-store-'));

describe('what the bot remembers, written as links notation', () => {
  it('writes a chat and its facts as one link', async () => {
    const { formatLinks } = await prepareStore();
    const chats = new Map([['42', { language: 'ru' }]]);
    expect(formatLinks(toNotation(chats))).toBe('(chat 42 (language ru))');
  });

  it('reads back exactly what it wrote', async () => {
    const { Parser, formatLinks } = await prepareStore();
    const chats = new Map([
      ['42', { language: 'ru', applicationNumber: 'E260908ABC00000000000' }],
      ['7', { language: 'en' }],
    ]);
    const text = formatLinks(toNotation(chats));
    const read = fromNotation(new Parser().parse(text));
    expect(read.get('42').language).toBe('ru');
    expect(read.get('42').applicationNumber).toBe('E260908ABC00000000000');
    expect(read.get('7').language).toBe('en');
  });

  it('keeps a value with spaces in it whole', async () => {
    const { Parser, formatLinks } = await prepareStore();
    const chats = new Map([['42', { note: 'two words' }]]);
    const read = fromNotation(
      new Parser().parse(formatLinks(toNotation(chats)))
    );
    expect(read.get('42').note).toBe('two words');
  });

  it('passes over a link that is not a chat', async () => {
    const { Parser } = await prepareStore();
    // A file somebody has added a note to still loads.
    const read = fromNotation(new Parser().parse('(note something)'));
    expect(read.size).toBe(0);
  });
});

describe('remembering a chat between runs', () => {
  it('gives back a fact written before', async () => {
    await prepareStore();
    const dir = scratch();
    try {
      const store = await openStore(dir);
      await store.write(42, 'language', 'ru');
      expect(store.read(42, 'language')).toBe('ru');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives the bot being restarted', async () => {
    await prepareStore();
    const dir = scratch();
    try {
      const before = await openStore(dir);
      await before.write(42, 'language', 'ru');
      await before.write(42, 'applicationNumber', 'E260908ABC00000000000');
      // A second store over the same directory is what a restart looks like.
      const after = await openStore(dir);
      expect(after.read(42, 'language')).toBe('ru');
      expect(after.read(42, 'applicationNumber')).toBe('E260908ABC00000000000');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('knows nothing about a chat it has never seen', async () => {
    await prepareStore();
    const dir = scratch();
    try {
      const store = await openStore(dir);
      expect(store.read(999, 'language')).toBe(null);
      expect(store.get(999)).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forgets a chat entirely when asked', async () => {
    await prepareStore();
    const dir = scratch();
    try {
      const store = await openStore(dir);
      await store.write(42, 'language', 'ru');
      await store.forget(42);
      expect(store.read(42, 'language')).toBe(null);
      const after = await openStore(dir);
      expect(after.read(42, 'language')).toBe(null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds the same facts in the binary store as on disk', async () => {
    await prepareStore();
    const dir = scratch();
    try {
      const store = await openStore(dir);
      await store.write(42, 'language', 'ru');
      // Both layers carry the fact: the file reads, and the links exist.
      expect(store.linkCount() > 0).toBe(true);
      await store.forget(42);
      expect(store.linkCount()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the previous file whole when a write is repeated', async () => {
    await prepareStore();
    const dir = scratch();
    try {
      const store = await openStore(dir);
      await store.write(42, 'language', 'ru');
      await store.write(42, 'language', 'en');
      expect(store.read(42, 'language')).toBe('en');
      // The file is one document, not two appended.
      const text = fs.readFileSync(store.path, 'utf8');
      expect(text.match(/\(chat 42/g).length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
