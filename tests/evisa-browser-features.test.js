import { describe, it, expect } from 'test-anywhere';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { readTrace } from 'browser-commander';
import {
  attachBrowserFeatures,
  checkpointBrowser,
  managedDownloads,
  stopBrowserFeatures,
} from '../src/evisa-browser-features.mjs';
import { readPageState } from '../src/evisa-trace.mjs';

describe('Browser Commander integration', () => {
  it('arms persistent downloads and a continuous, privacy-aware trace', async () => {
    const calls = { checkpoints: [] };
    const downloads = { directory: '/tmp/downloads' };
    const trace = {
      path: '/tmp/run.bc-trace',
      checkpoint: async (name, options) => {
        calls.checkpoints.push({ name, options });
        return { index: calls.checkpoints.length, name };
      },
      stop: async () => {
        calls.traceStopped = true;
        return { path: '/tmp/run.bc-trace' };
      },
    };
    const commander = {
      startTrace: async (options) => {
        calls.trace = options;
        return trace;
      },
      destroy: async () => {
        calls.destroyed = true;
      },
    };
    const page = {
      context: () => 'playwright-context',
      once: (name, listener) => {
        calls.listener = { name, listener };
      },
    };

    const attached = await attachBrowserFeatures(page, {
      downloadsDirectory: '/tmp/downloads',
      traceOutput: '/tmp/run.bc-trace',
      commanderFactory: (options) => {
        calls.commander = options;
        return commander;
      },
      downloadManagerFactory: async (options) => {
        calls.downloads = options;
        return downloads;
      },
      viewerWriter: async (tracePath) => {
        calls.viewer = tracePath;
      },
      onCheckpoint: async (checkpoint) => {
        calls.mirrored = checkpoint;
      },
    });

    expect(calls.commander.page).toBe(page);
    expect(calls.commander.enableDialogManager).toBe(false);
    expect(calls.downloads).toEqual({
      engine: 'playwright',
      context: 'playwright-context',
      directory: '/tmp/downloads',
      persist: true,
      conflict: 'rename',
    });
    expect(calls.trace.output).toBe('/tmp/run.bc-trace');
    expect(calls.trace.mode).toBe('continuous');
    expect(calls.trace.screenshots).toBe('checkpoints');
    expect(calls.trace.dom.mutations).toBe(true);
    expect(calls.trace.privacy.redactSelectors).toContain(
      'input[autocomplete="one-time-code"]'
    );
    expect(attached.downloads).toBe(downloads);
    expect(managedDownloads(page)).toBe(downloads);
    expect(calls.listener.name).toBe('close');

    expect(
      await checkpointBrowser(page, 'form-opened', { actor: 'automation' })
    ).toEqual({ index: 1, name: 'form-opened' });
    expect(calls.checkpoints).toEqual([
      {
        name: 'form-opened',
        options: { actor: 'automation', reason: 'checkpoint' },
      },
    ]);
    expect(calls.mirrored.name).toBe('form-opened');
    expect(calls.mirrored.tracePath).toBe('/tmp/run.bc-trace');
    expect(calls.mirrored.entry.index).toBe(1);

    await stopBrowserFeatures(page);
    expect(calls.traceStopped).toBe(true);
    expect(calls.viewer).toBe('/tmp/run.bc-trace');
    expect(calls.destroyed).toBe(true);
    expect(managedDownloads(page)).toBe(null);
  });

  it('can add managed downloads on demand without replacing the trace', async () => {
    const downloads = { directory: '/tmp/late-downloads' };
    let configured = 0;
    const commander = { destroy: async () => {} };
    const page = { context: () => 'context', once: () => {} };

    await attachBrowserFeatures(page, {
      commanderFactory: () => commander,
      downloadManagerFactory: async () => {
        configured += 1;
        return downloads;
      },
    });
    const { ensureManagedDownloads } =
      await import('../src/evisa-browser-features.mjs');
    expect(await ensureManagedDownloads(page, '/tmp/late-downloads')).toBe(
      downloads
    );
    expect(await ensureManagedDownloads(page, '/tmp/late-downloads')).toBe(
      downloads
    );
    expect(configured).toBe(1);
    await stopBrowserFeatures(page);
  });
});

describe('Browser Commander recording', () => {
  it('records a base snapshot, live values, mutations and an offline viewer', async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'evisa-browser-features-')
    );
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<main><input id="name"><input id="mail-code" autocomplete="one-time-code">' +
          '<input id="captcha-answer"><ul id="items"></ul></main>'
      );
      const output = path.join(directory, 'run.bc-trace');
      await attachBrowserFeatures(page, { traceOutput: output });
      await checkpointBrowser(page, 'initial');
      await page.fill('#name', 'Ada');
      await page.fill('#mail-code', '654321');
      await page.fill('#captcha-answer', 'A1B2C3');
      await page.evaluate(() => {
        const item = globalThis.document.createElement('li');
        item.id = 'created';
        item.textContent = 'ready';
        globalThis.document.querySelector('#items').append(item);
      });
      await checkpointBrowser(page, 'filled');
      await stopBrowserFeatures(page);

      const recorded = await readTrace(output);
      expect(recorded.checkpoints.map(({ name }) => name)).toEqual([
        'initial',
        'filled',
      ]);
      expect((await recorded.state(1)).controls[0].value).toBe('');
      expect((await recorded.state(2)).controls[0].value).toBe('Ada');
      const secondState = JSON.stringify(await recorded.state(2));
      const secondHtml = await recorded.html(2);
      expect(secondState.includes('654321')).toBe(false);
      expect(secondState.includes('A1B2C3')).toBe(false);
      expect(secondHtml.includes('654321')).toBe(false);
      expect(secondHtml.includes('A1B2C3')).toBe(false);
      const semantic = await readPageState(page);
      expect(semantic['mail-code']).toBe('(withheld)');
      expect(semantic['captcha-answer']).toBe('(withheld)');
      expect((await recorded.mutations(1)).length > 0).toBe(true);
      expect(fs.existsSync(path.join(output, 'viewer.html'))).toBe(true);
    } finally {
      await stopBrowserFeatures(page);
      await browser.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
