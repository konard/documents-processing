// eml-to-pdf.mjs — convert a parsed email to PDF with several independent
// engines, so that if one fails another still produces a PDF. The goal is a
// faithful, print-to-PDF-quality rendering that loses no visible content.
//
// Engines (each tried independently; all that succeed are returned):
//   1. chrome  — the system Chrome/Chromium via the DevTools Protocol
//                (Page.printToPDF). Highest fidelity; no Chromium download.
//   2. browser-commander — link-foundation/browser-commander's pdf() over its
//                Playwright/Puppeteer engine, when that package is installed.
//   3. wkhtmltopdf — the wkhtmltopdf CLI, when installed.
//   4. js      — a pure pdf-lib text rendering (no browser). Always available;
//                lowest fidelity but never loses the textual content.
//
// Inline images referenced as cid: in the HTML are inlined as data: URIs from
// the message attachments first, so no embedded image is lost in any engine.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { simpleParser } from 'mailparser';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { resolveUnicodeFont } from './font-tools.mjs';

// ---- system Chrome discovery ----------------------------------------------

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

export function findSystemChrome() {
  return (
    CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null
  );
}

// ---- email → self-contained HTML ------------------------------------------

const escapeHtml = (text) =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// Replace cid: image references with inline data: URIs from the attachments so
// the rendered HTML carries every embedded image with no external requests.
function inlineCidImages(html, attachments) {
  let out = html;
  for (const attachment of attachments) {
    if (!attachment.cid) {
      continue;
    }
    const dataUri = `data:${attachment.contentType};base64,${attachment.content.toString('base64')}`;
    const cidRef = new RegExp(
      `cid:${attachment.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      'g'
    );
    out = out.replace(cidRef, dataUri);
  }
  return out;
}

// Build one self-contained HTML document: a header block with the key envelope
// fields, then the message's own HTML body (or its text body as a fallback).
// options.onePage: emit compact CSS (tighter header, capped banner image, no
// large gaps) so the scaling step in the printer has less to shrink away.
export function emailToHtml(parsed, options = {}) {
  const header = [
    ['From', parsed.from?.text],
    ['To', parsed.to?.text],
    ['Cc', parsed.cc?.text],
    ['Date', parsed.date ? parsed.date.toISOString() : ''],
    ['Subject', parsed.subject],
  ]
    .filter(([, value]) => value)
    .map(
      ([label, value]) =>
        `<tr><td class="k">${label}</td><td class="v">${escapeHtml(value)}</td></tr>`
    )
    .join('');

  const bodyHtml = parsed.html
    ? inlineCidImages(parsed.html, parsed.attachments || [])
    : `<pre>${escapeHtml(parsed.text || '')}</pre>`;

  // Compact styling for the one-page variant: smaller margin and header type,
  // and a ceiling on the tall hero banner some airline templates lead with, so
  // the meaningful text keeps more of the page.
  const compactCss = options.onePage
    ? `
  body { margin: 12px; }
  table.hdr td { padding: 1px 6px; font-size: 10px; }
  hr { margin: 4px 0 10px; }
  img { max-height: 220px; object-fit: contain; }`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  body { font-family: Arial, "Helvetica Neue", sans-serif; margin: 24px; color: #111; }
  table.hdr { border-collapse: collapse; margin-bottom: 16px; width: 100%; }
  table.hdr td { padding: 2px 8px; vertical-align: top; font-size: 12px; }
  table.hdr td.k { font-weight: bold; color: #555; white-space: nowrap; width: 1%; }
  hr { border: none; border-top: 1px solid #ccc; margin: 8px 0 20px; }
  pre { white-space: pre-wrap; word-wrap: break-word; font-family: inherit; }
  img { max-width: 100%; }${compactCss}
</style></head><body>
<table class="hdr">${header}</table><hr>
${bodyHtml}
</body></html>`;
}

// ---- engine 1: system Chrome via DevTools Page.printToPDF -----------------

// GET a JSON endpoint on the DevTools HTTP server once.
function getJson(port, endpoint) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: endpoint },
      (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on('error', reject);
  });
}

// Poll the DevTools server until a page target is available, then return that
// page's WebSocket debugger URL (the Page.* domain lives on a page target, not
// on the browser-level endpoint).
function waitForPageTarget(port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const poll = async () => {
      try {
        const targets = await getJson(port, '/json');
        const page = targets.find(
          (target) => target.type === 'page' && target.webSocketDebuggerUrl
        );
        if (page) {
          resolve(page.webSocketDebuggerUrl);
          return;
        }
        throw new Error('no page target yet');
      } catch {
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        if (elapsedMs > timeoutMs) {
          reject(new Error('Chrome DevTools did not become ready'));
        } else {
          setTimeout(poll, 150);
        }
      }
    };
    poll();
  });
}

// Drive Chrome's DevTools Protocol over its WebSocket to load the HTML and
// print it to PDF — the real "Print to PDF", not the limited CLI flag.
// options.onePage: shrink the whole email onto a single A4 page (measure the
// rendered content height, then pick a print scale so it never spills over).
async function chromePrintToPdf(chromePath, html, outPath, options = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-chrome-'));
  const port = 9222 + (process.pid % 2000);
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      // Route this throwaway profile's password store to Chrome's basic
      // backend, not the OS credential store, so no macOS Keychain dialog pops.
      '--password-store=basic',
    ],
    { stdio: 'ignore' }
  );

  try {
    const wsUrl = await waitForPageTarget(port);
    const socket = await openWebSocket(wsUrl);
    const pdfBase64 = await runCdpSession(socket, html, options);
    fs.writeFileSync(outPath, Buffer.from(pdfBase64, 'base64'));
  } finally {
    // Wait for Chrome to actually exit before removing its user-data-dir, so
    // cleanup doesn't race Chrome still writing into it. A cleanup failure must
    // never discard an already-written PDF, so it is swallowed.
    child.kill('SIGKILL');
    await once(child, 'exit').catch(() => {});
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
  return outPath;
}

// Open a WebSocket to Chrome's DevTools endpoint. Prefers the runtime's global
// WebSocket (Node 21+); otherwise loads the 'ws' package. Resolves once open.
async function openWebSocket(wsUrl) {
  const WebSocketImpl =
    typeof globalThis.WebSocket === 'function'
      ? globalThis.WebSocket
      : (await import('ws')).WebSocket;
  const socket = new WebSocketImpl(wsUrl, { perMessageDeflate: false });
  await once(socket, 'open');
  return socket;
}

// A4 printable geometry in inches, used to fit a whole email on one page.
const A4_WIDTH_IN = 8.27;
const A4_HEIGHT_IN = 11.69;
const PAGE_MARGIN_IN = 0.4;

// Choose a Page.printToPDF scale so the rendered content fits on a single A4
// page. Measures the document's pixel size (via Runtime.evaluate) and compares
// its aspect against the printable box; CSS px are 96 per inch when printing.
// Never scales up past 1, and never below 0.5 (past that text is unreadable —
// better to let it overflow than to produce an illegible page).
function onePageScale(widthPx, heightPx) {
  const printableWidthPx = (A4_WIDTH_IN - 2 * PAGE_MARGIN_IN) * 96;
  const printableHeightPx = (A4_HEIGHT_IN - 2 * PAGE_MARGIN_IN) * 96;
  const widthScale = printableWidthPx / widthPx;
  const heightScale = printableHeightPx / heightPx;
  const scale = Math.min(1, widthScale, heightScale);
  return Math.max(0.5, Number(scale.toFixed(3)));
}

// Minimal CDP conversation: enable Page, navigate to a data: URL of the HTML,
// wait for load, then Page.printToPDF with background printing on. Uses the
// 'ws' EventEmitter API ('message' delivers a Buffer/string payload directly).
// options.onePage: measure the laid-out content and pick a print scale so the
// whole email lands on one A4 page.
function runCdpSession(socket, html, options = {}) {
  return new Promise((resolve, reject) => {
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => {
      const messageId = ++id;
      return new Promise((res, rej) => {
        pending.set(messageId, { res, rej });
        socket.send(JSON.stringify({ id: messageId, method, params }));
      });
    };

    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          rej(new Error(message.error.message));
        } else {
          res(message.result);
        }
      }
    });
    socket.on('error', reject);

    (async () => {
      try {
        await send('Page.enable');
        await send('Runtime.enable');
        const dataUrl = `data:text/html;base64,${Buffer.from(html).toString('base64')}`;
        await send('Page.navigate', { url: dataUrl });
        await new Promise((r) => setTimeout(r, 700)); // let images/layout settle

        const printParams = {
          printBackground: true,
          preferCSSPageSize: false,
          marginTop: PAGE_MARGIN_IN,
          marginBottom: PAGE_MARGIN_IN,
          marginLeft: PAGE_MARGIN_IN,
          marginRight: PAGE_MARGIN_IN,
        };

        if (options.onePage) {
          // Measure the full laid-out content, then scale so it fits one A4.
          const { result } = await send('Runtime.evaluate', {
            expression: `(() => {
              const b = globalThis.document.body;
              const d = globalThis.document.documentElement;
              return JSON.stringify({
                width: Math.max(b.scrollWidth, d.scrollWidth),
                height: Math.max(b.scrollHeight, d.scrollHeight),
              });
            })()`,
            returnByValue: true,
          });
          const size = JSON.parse(result.value);
          printParams.scale = onePageScale(size.width, size.height);
          // Force exactly one page even if a stray pixel would round it over.
          printParams.pageRanges = '1';
        }

        const result = await send('Page.printToPDF', printParams);
        socket.close();
        resolve(result.data);
      } catch (error) {
        reject(error);
      }
    })();
  });
}

// ---- engine 2: browser-commander (optional) -------------------------------

async function browserCommanderToPdf(html, outPath) {
  let bc;
  try {
    bc = await import('browser-commander');
  } catch {
    throw new Error('browser-commander not installed');
  }
  const { browser, page } = await bc.launchBrowser({
    engine: 'playwright',
    headless: true,
  });
  try {
    await page.setContent(html, { waitUntil: 'networkidle' });
    await bc.pdf({
      page,
      engine: 'playwright',
      pdfOptions: { path: outPath, printBackground: true, format: 'A4' },
    });
  } finally {
    await browser.close();
  }
  return outPath;
}

// ---- engine 3: wkhtmltopdf (optional) -------------------------------------

function wkhtmltopdfToPdf(html, outPath) {
  const which = spawnSync('which', ['wkhtmltopdf']);
  if (which.status !== 0) {
    throw new Error('wkhtmltopdf not installed');
  }
  const htmlPath = `${outPath}.src.html`;
  fs.writeFileSync(htmlPath, html);
  try {
    const result = spawnSync(
      'wkhtmltopdf',
      ['--enable-local-file-access', '--encoding', 'utf-8', htmlPath, outPath],
      { stdio: 'ignore' }
    );
    if (result.status !== 0) {
      throw new Error(`wkhtmltopdf exited with status ${result.status}`);
    }
  } finally {
    fs.rmSync(htmlPath, { force: true });
  }
  return outPath;
}

// ---- engine 4: pure pdf-lib text fallback ---------------------------------

// Render the plain-text body (or a stripped HTML body) with pdf-lib. Always
// works; keeps the text even when no browser/CLI engine is available.
async function jsTextToPdf(parsed, dataDir, outPath) {
  const lines = [];
  const push = (label, value) => value && lines.push(`${label}: ${value}`);
  push('From', parsed.from?.text);
  push('To', parsed.to?.text);
  push('Cc', parsed.cc?.text);
  push('Date', parsed.date ? parsed.date.toISOString() : '');
  push('Subject', parsed.subject);
  lines.push('');
  const body =
    parsed.text ||
    (parsed.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n');
  lines.push(...body.split('\n'));

  const pdf = await PDFDocument.create();
  let font;
  const fontPath = await resolveUnicodeFont(dataDir);
  if (fontPath) {
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    pdf.registerFontkit(fontkit);
    font = await pdf.embedFont(fs.readFileSync(fontPath), { subset: true });
  } else {
    font = await pdf.embedFont(StandardFonts.Helvetica);
  }

  const fontSize = 10;
  const lineHeight = 14;
  const margin = 40;
  let page = pdf.addPage();
  let { width, height } = page.getSize();
  let y = height - margin;
  const maxWidth = width - margin * 2;

  const drawLine = (text) => {
    if (y < margin) {
      page = pdf.addPage();
      ({ width, height } = page.getSize());
      y = height - margin;
    }
    page.drawText(text, { x: margin, y, size: fontSize, font });
    y -= lineHeight;
  };

  // Wrap each source line to the page width by character budget.
  for (const raw of lines) {
    const text = raw.replace(/\t/g, '    ');
    if (text === '') {
      y -= lineHeight;
      continue;
    }
    let current = '';
    for (const word of text.split(' ')) {
      const trial = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(trial, fontSize) > maxWidth && current) {
        drawLine(current);
        current = word;
      } else {
        current = trial;
      }
    }
    if (current) {
      drawLine(current);
    }
  }

  fs.writeFileSync(outPath, await pdf.save());
  return outPath;
}

// ---- orchestration --------------------------------------------------------

// Convert one .eml (Buffer or path) to PDFs with every available engine.
// Returns { parsed, results: [{ engine, path } | { engine, error }] }.
export async function emlToPdfs(emlInput, outPathBase, dataDir) {
  const emlBuffer = Buffer.isBuffer(emlInput)
    ? emlInput
    : fs.readFileSync(emlInput);
  const parsed = await simpleParser(emlBuffer);
  const html = emailToHtml(parsed);

  const engines = [
    {
      name: 'chrome',
      run: async (out) => {
        const chrome = findSystemChrome();
        if (!chrome) {
          throw new Error('no system Chrome/Chromium found');
        }
        return await chromePrintToPdf(chrome, html, out);
      },
    },
    { name: 'bc', run: (out) => browserCommanderToPdf(html, out) },
    { name: 'wkhtmltopdf', run: (out) => wkhtmltopdfToPdf(html, out) },
    { name: 'js', run: (out) => jsTextToPdf(parsed, dataDir, out) },
  ];

  const results = [];
  for (const engine of engines) {
    const out = `${outPathBase}-${engine.name}.pdf`;
    try {
      await engine.run(out);
      results.push({ engine: engine.name, path: out });
    } catch (error) {
      results.push({ engine: engine.name, error: error.message });
    }
  }
  return { parsed, results };
}

// Render one .eml to a SINGLE-PAGE PDF via system Chrome: the whole email is
// laid out, measured, and scaled so it fits on one A4 page — nothing is cut,
// the airline template just shrinks to fit. Used to build the FRRO exhibits,
// where each cancellation/change notice must be one page. Returns the outPath.
// Throws if no system Chrome/Chromium is found (this variant is Chrome-only,
// as the fit-to-page measurement needs the DevTools protocol).
export async function emlToOnePagePdf(emlInput, outPath) {
  const emlBuffer = Buffer.isBuffer(emlInput)
    ? emlInput
    : fs.readFileSync(emlInput);
  const parsed = await simpleParser(emlBuffer);
  const html = emailToHtml(parsed, { onePage: true });

  const chrome = findSystemChrome();
  if (!chrome) {
    throw new Error('no system Chrome/Chromium found');
  }
  await chromePrintToPdf(chrome, html, outPath, { onePage: true });
  return outPath;
}
