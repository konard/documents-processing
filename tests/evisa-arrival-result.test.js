import { describe, it, expect } from 'test-anywhere';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  configuredDownloadsDirectory,
  DECLARATION_PDF_NAME,
  DECLARATION_QR_NAME,
  keepBrowserDownloads,
  readDeclarationResult,
  sendDuplicateDeclarationResult,
  sendDeclarationResult,
} from '../src/evisa-arrival-result.mjs';
import { MESSAGES } from '../src/evisa-messages.mjs';

describe('declaration result delivery', () => {
  it('uses Downloads by default and accepts an override', () => {
    expect(configuredDownloadsDirectory({}, { home: '/home/person' })).toBe(
      '/home/person/Downloads'
    );
    expect(
      configuredDownloadsDirectory(
        { EVISA_BOT_DOWNLOADS_DIR: '~/Travel' },
        { home: '/home/person' }
      )
    ).toBe('/home/person/Travel');
    expect(
      configuredDownloadsDirectory({ EVISA_BOT_DOWNLOADS_DIR: 'temporary' })
    ).toBe(null);
  });

  it('logs full result markup and sends a named PDF and QR separately', async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'evisa-result-test-')
    );
    const browser = await chromium.launch({
      headless: true,
      downloadsPath: directory,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 900, height: 700 },
      });
      keepBrowserDownloads(page, directory);
      await page.setContent(`
        <h1>Your submission is successful!</h1>
        <section><canvas id="qr" width="220" height="220"></canvas>
          <p>You can save this QR code to look up your declaration later</p></section>
        <button id="download">Download PDF Pre-Arrival Information</button>
        <script>
          const canvas = document.querySelector('#qr');
          canvas.getContext('2d').fillRect(0, 0, 220, 220);
          document.querySelector('#download').addEventListener('click', () => {
            const pdf = new Blob(['%PDF-1.3\\n%%EOF'], { type: 'application/pdf' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(pdf);
            link.download = '0135de7a-6249-478e-b6e7-5d27f62790c0';
            link.click();
          });
        </script>
      `);
      const markup = [];
      const replies = [];
      const documents = [];
      const photos = [];
      class InputFile {
        constructor(source, filename) {
          this.source = source;
          this.filename = filename;
        }
      }
      const result = await sendDeclarationResult({
        ctx: {
          reply: async (text) => replies.push(text),
          replyWithDocument: async (file, options) =>
            documents.push({ file, options }),
          replyWithPhoto: async (file, options) =>
            photos.push({ file, options }),
        },
        chatId: 7,
        page,
        strings: MESSAGES.en,
        InputFile,
        downloadsDirectory: directory,
        keepMarkup: async (chatId, markedPage, moment) => {
          markup.push({ chatId, moment, html: await markedPage.content() });
        },
      });

      expect(result.failures).toEqual([]);
      expect(markup[0].chatId).toBe(7);
      expect(markup[0].moment).toBe('arrival-result');
      expect(markup[0].html).toContain('Your submission is successful!');
      expect(replies).toEqual([MESSAGES.en.arrivalFiled]);
      expect(documents.length).toBe(1);
      expect(documents[0].file.filename).toBe(DECLARATION_PDF_NAME);
      expect(fs.readFileSync(documents[0].file.source, 'utf8')).toContain(
        '%PDF-'
      );
      expect(photos.length).toBe(1);
      expect(photos[0].file.filename).toBe(DECLARATION_QR_NAME);
      expect(photos[0].file.source.subarray(1, 4).toString()).toBe('PNG');
    } finally {
      await browser.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recognizes and reports a duplicate without looking for artifacts', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <p>Duplicate pre-arrival information for traveller Passport Number [REDACTED]</p>
        <button>New Submission</button>
      `);
      expect(await readDeclarationResult(page)).toEqual({
        status: 'duplicate',
        passportNumber: '[REDACTED]',
      });
      const markup = [];
      const photos = [];
      class InputFile {
        constructor(source, filename) {
          this.source = source;
          this.filename = filename;
        }
      }
      await sendDuplicateDeclarationResult({
        ctx: {
          reply: async () => {},
          replyWithPhoto: async (file, options) =>
            photos.push({ file, options }),
        },
        chatId: 9,
        page,
        strings: MESSAGES.en,
        passportNumber: '[REDACTED]',
        InputFile,
        keepMarkup: async (_chatId, markedPage, moment) =>
          markup.push({ moment, html: await markedPage.content() }),
      });
      expect(markup[0].moment).toBe('arrival-result-duplicate');
      expect(markup[0].html).toContain('Duplicate pre-arrival information');
      expect(photos.length).toBe(1);
      expect(photos[0].options.caption).toContain(
        'No new declaration was filed'
      );
      expect(photos[0].options.caption).toContain('[REDACTED]');
    } finally {
      await browser.close();
    }
  });
});
