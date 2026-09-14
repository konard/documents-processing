import { describe, it, expect } from 'test-anywhere';
import { downloadFile } from '../src/evisa-details.mjs';

describe('downloading a document from Telegram', () => {
  it('retries a transient network failure before blaming the document', async () => {
    let calls = 0;
    const waited = [];
    const fetched = async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error('fetch failed');
      }
      return {
        ok: true,
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      };
    };

    const downloaded = await downloadFile(
      { getFile: async () => ({ file_path: 'documents/photo.jpg' }) },
      'secret',
      {
        fetchFile: fetched,
        wait: async (ms) => waited.push(ms),
      }
    );

    expect(calls).toBe(3);
    expect(waited).toEqual([250, 750]);
    expect(downloaded.buffer).toEqual(Buffer.from([1, 2, 3]));
    expect(downloaded.extension).toBe('.jpg');
  });

  it('does not retry a permanent Telegram rejection', async () => {
    let calls = 0;
    const fetched = async () => {
      calls += 1;
      return { ok: false, status: 400 };
    };

    let error = null;
    try {
      await downloadFile(
        { getFile: async () => ({ file_path: 'documents/photo.jpg' }) },
        'secret',
        { fetchFile: fetched, wait: async () => {} }
      );
    } catch (caught) {
      error = caught;
    }
    expect(error?.message.includes('HTTP 400')).toBe(true);
    expect(calls).toBe(1);
  });

  it('retries Telegram throttling and server errors', async () => {
    const statuses = [429, 500, 200];
    let calls = 0;
    const fetched = async () => {
      const status = statuses[calls++];
      return status === 200
        ? {
            ok: true,
            arrayBuffer: async () => Uint8Array.from([9]).buffer,
          }
        : { ok: false, status };
    };
    const downloaded = await downloadFile(
      { getFile: async () => ({ file_path: 'documents/photo.jpg' }) },
      'secret',
      { fetchFile: fetched, wait: async () => {} }
    );
    expect(calls).toBe(3);
    expect(downloaded.buffer).toEqual(Buffer.from([9]));
  });

  it('reports a transient failure only after exhausting its retries', async () => {
    let calls = 0;
    let error;
    try {
      await downloadFile(
        { getFile: async () => ({ file_path: 'documents/photo.jpg' }) },
        'secret',
        {
          fetchFile: async () => {
            calls += 1;
            return { ok: false, status: 503 };
          },
          wait: async () => {},
        }
      );
    } catch (caught) {
      error = caught;
    }
    expect(calls).toBe(3);
    expect(error?.message.includes('HTTP 503')).toBe(true);
  });
});
