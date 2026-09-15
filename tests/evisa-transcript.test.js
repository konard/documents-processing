import { describe, it, expect } from 'test-anywhere';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openTranscript,
  readTranscript,
  renderTranscript,
  describeIncoming,
  describeOutgoing,
} from '../src/evisa-transcript.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-tr-'));

describe('what the applicant sent', () => {
  it('keeps the text of a message', () => {
    expect(describeIncoming({ text: 'hello' }).text).toBe('hello');
  });

  it('names a document by its own file name', () => {
    const seen = describeIncoming({
      document: { file_id: 'A', file_name: 'passport.jpg', file_size: 100 },
    });
    expect(seen.kind).toBe('document');
    expect(seen.file.name).toBe('passport.jpg');
  });

  it('takes the largest size Telegram offers for a photo', () => {
    // Telegram sends several; the last is the one the bot works from.
    const seen = describeIncoming({
      photo: [
        { file_id: 'small', file_size: 900 },
        { file_id: 'large', file_size: 95000 },
      ],
    });
    expect(seen.file.id).toBe('large');
  });
});

describe('what the bot sent', () => {
  it('keeps the text and the buttons under it', () => {
    const seen = describeOutgoing('sendMessage', {
      text: 'choose',
      reply_markup: { inline_keyboard: [[{ text: 'A' }, { text: 'B' }]] },
    });
    expect(seen.text).toBe('choose');
    expect(seen.buttons).toEqual(['A', 'B']);
  });

  it('names a picture by the file it was sent as', () => {
    const seen = describeOutgoing('sendPhoto', {
      photo: { filename: 'section-1.jpg' },
      caption: '1. PERSONAL INFORMATION',
    });
    expect(seen.kind).toBe('photo');
    expect(seen.caption).toBe('1. PERSONAL INFORMATION');
  });

  it('cuts a body too long for a line', () => {
    const seen = describeOutgoing('sendMessage', { text: 'x'.repeat(9000) });
    expect(seen.text.length < 9000).toBe(true);
    expect(seen.text.endsWith('…')).toBe(true);
  });
});

describe('reading a conversation back', () => {
  it('gives both sides in the order they were said', () => {
    const dir = scratch();
    try {
      const transcript = openTranscript(dir);
      transcript.fromApplicant(42, { text: '/start' });
      transcript.fromBot(42, 'sendMessage', { chat_id: 42, text: 'hello' });
      transcript.fromApplicant(42, { text: 'thanks' });
      const entries = readTranscript(transcript.pathFor(42));
      expect(entries.length).toBe(3);
      expect(entries.map((entry) => entry.from)).toEqual([
        'applicant',
        'bot',
        'applicant',
      ]);
      expect(renderTranscript(entries)).toContain('← /start');
      expect(renderTranscript(entries)).toContain('→ hello');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a file the applicant sent, under its own name', () => {
    const dir = scratch();
    try {
      const transcript = openTranscript(dir);
      const kept = transcript.keepFile(42, Buffer.from('bytes'), 'booking.jpg');
      expect(kept.endsWith('booking.jpg')).toBe(true);
      expect(fs.readFileSync(kept, 'utf8')).toBe('bytes');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes nothing when values are being withheld', () => {
    const dir = scratch();
    try {
      const transcript = openTranscript(dir, { enabled: false });
      transcript.fromApplicant(42, { text: 'private' });
      expect(fs.existsSync(transcript.pathFor(42))).toBe(false);
      expect(transcript.keepFile(42, Buffer.from('x'), 'a.jpg')).toBe(null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes over a line left half-written', () => {
    const dir = scratch();
    try {
      const file = path.join(dir, 'chat-42.jsonl');
      fs.writeFileSync(file, '{"from":"bot","text":"kept"}\n{"from":"bot",');
      const entries = readTranscript(file);
      expect(entries.length).toBe(1);
      expect(entries[0].text).toBe('kept');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives nothing for a chat never spoken to', () => {
    expect(readTranscript('/nowhere/chat-1.jsonl')).toEqual([]);
  });
});

describe('clearing transcripts on the same terms as the log', () => {
  it('removes what is past the retention and keeps what is not', async () => {
    const { sweepTranscripts } = await import('../src/evisa-transcript.mjs');
    const dir = scratch();
    try {
      const old = path.join(dir, 'chat-1.jsonl');
      const fresh = path.join(dir, 'chat-2.jsonl');
      fs.writeFileSync(old, '{}\n');
      fs.writeFileSync(fresh, '{}\n');
      // Ten days back, against a retention of seven.
      const back = Date.now() - 10 * 86400000;
      fs.utimesSync(old, back / 1000, back / 1000);
      expect(sweepTranscripts(dir, 7)).toBe(1);
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves anything that is not a transcript alone', async () => {
    const { sweepTranscripts } = await import('../src/evisa-transcript.mjs');
    const dir = scratch();
    try {
      const other = path.join(dir, 'notes.txt');
      fs.writeFileSync(other, 'x');
      const back = Date.now() - 400 * 86400000;
      fs.utimesSync(other, back / 1000, back / 1000);
      expect(sweepTranscripts(dir, 7)).toBe(0);
      expect(fs.existsSync(other)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
