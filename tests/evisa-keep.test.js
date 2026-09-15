// Tests for the values kept between runs of the bot.
//
// A restart used to empty every session, so an applicant who had sent five
// documents was asked for them again, and a fill started with no nationality
// — which the site needs before it will draw a single field.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'test-anywhere';
import {
  keepCollectedValues,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
} from '../src/evisa-keep.mjs';

/**
 * A directory of its own for each test, removed after it.
 *
 * Awaited before the removal, since every caller here is async and a
 * directory taken away mid-test leaves the keeper nothing to write to.
 */
async function inTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-keep-test-'));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const openKeeper = (dir, options = {}) =>
  keepCollectedValues({
    directory: dir,
    valuesAllowed: () => true,
    retentionDays: 7,
    ...options,
  });

describe('the values kept between runs', () => {
  it('reads back exactly what was written', async () => {
    await inTempDir(async (dir) => {
      const keep = openKeeper(dir);
      const data = {
        surname: 'TRAVELLER',
        givenName: 'JOHN',
        nationality: 'Russia',
        visaNumber: '712345678/EV',
      };
      await keep.write(7, data);
      expect(keep.read(7)).toEqual(data);
    });
  });

  it('keeps a value with quotes and punctuation whole', async () => {
    // The chat store's notation cannot carry these, which is why the values
    // are kept in a file of their own: an address is full of them.
    await inTempDir(async (dir) => {
      const keep = openKeeper(dir);
      const address = "12 O'Some Street, Nha Trang";
      await keep.write(7, { address });
      expect(keep.read(7).address).toBe(address);
    });
  });

  it('gives a chat with nothing kept an empty record', async () => {
    await inTempDir((dir) => {
      expect(openKeeper(dir).read(99)).toEqual({});
    });
  });

  it('passes over a file that will not parse', async () => {
    await inTempDir(async (dir) => {
      const keep = openKeeper(dir);
      await keep.write(7, { surname: 'TRAVELLER' });
      fs.writeFileSync(path.join(dir, 'collected', 'chat-7.json'), '{ half');
      expect(keep.read(7)).toEqual({});
    });
  });

  it('forgets a chat on request, which is what /reset means', async () => {
    await inTempDir(async (dir) => {
      const keep = openKeeper(dir);
      await keep.write(7, { surname: 'TRAVELLER' });
      keep.forget(7);
      expect(keep.read(7)).toEqual({});
    });
  });

  it('writes nothing at all where values are withheld', async () => {
    await inTempDir(async (dir) => {
      const keep = openKeeper(dir, { valuesAllowed: () => false });
      await keep.write(7, { surname: 'TRAVELLER' });
      expect(fs.existsSync(path.join(dir, 'collected'))).toBe(false);
      expect(keep.read(7)).toEqual({});
    });
  });

  it('keeps them where only their owner can read them', async () => {
    // The same terms the documents they were read from are kept on.
    await inTempDir(async (dir) => {
      const keep = openKeeper(dir);
      await keep.write(7, { surname: 'TRAVELLER' });
      const file = path.join(dir, 'collected', 'chat-7.json');
      expect(PRIVATE_FILE_MODE).toBe(0o600);
      expect(PRIVATE_DIRECTORY_MODE).toBe(0o700);
      // Windows controls access through ACLs and does not preserve POSIX mode
      // bits. Unix platforms must expose the requested owner-only modes.
      if (process.platform !== 'win32') {
        expect(fs.statSync(file).mode & 0o777).toBe(PRIVATE_FILE_MODE);
        expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(
          PRIVATE_DIRECTORY_MODE
        );
      }
    });
  });

  it('drops what is past the retention on the way out', async () => {
    // Checked on read as well as by the sweep, so a bot that has not swept
    // yet still never restores a record older than the documents behind it.
    await inTempDir(async (dir) => {
      const keep = openKeeper(dir);
      const file = path.join(dir, 'collected', 'chat-7.json');
      await keep.write(7, { surname: 'TRAVELLER' });
      const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
      fs.writeFileSync(
        file,
        JSON.stringify({ at: old, data: { surname: 'TRAVELLER' } })
      );
      expect(keep.read(7)).toEqual({});
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  it('sweeps what is past the retention, and leaves the rest', async () => {
    await inTempDir(async (dir) => {
      const keep = openKeeper(dir);
      await keep.write(7, { surname: 'TRAVELLER' });
      await keep.write(8, { surname: 'SAMPLE' });
      const stale = path.join(dir, 'collected', 'chat-7.json');
      const old = (Date.now() - 8 * 86_400_000) / 1000;
      fs.utimesSync(stale, old, old);
      expect(keep.sweep()).toBe(1);
      expect(fs.existsSync(stale)).toBe(false);
      expect(keep.read(8).surname).toBe('SAMPLE');
    });
  });

  it('sweeps a directory that was never written to', async () => {
    await inTempDir((dir) => {
      expect(openKeeper(dir).sweep()).toBe(0);
    });
  });
});
