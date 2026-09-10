import { describe, it, expect } from 'test-anywhere';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openTrace,
  changesBetween,
  sweepTraces,
  readTrace,
  STEPS,
} from '../src/evisa-trace.mjs';
import { prepareStore } from '../src/evisa-store.mjs';

const notation = await prepareStore();

/** A trace in a directory of its own, removed when the test is done. */
function withTrace(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-trace-test-'));
  try {
    return work(openTrace(dir, { notation }), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('what changed on the page', () => {
  it('reports a field that was set, with what it was and what it became', () => {
    expect(changesBetween({ a: '' }, { a: 'NOW' })).toEqual([
      { id: 'a', was: '', now: 'NOW' },
    ]);
  });

  it('reports a field that was cleared', () => {
    expect(changesBetween({ a: 'WAS' }, { a: '' })).toEqual([
      { id: 'a', was: 'WAS', now: '' },
    ]);
  });

  it('says nothing about a field that did not move', () => {
    expect(changesBetween({ a: 'SAME' }, { a: 'SAME' })).toEqual([]);
  });

  it('reports a field the page has grown, and one it has lost', () => {
    expect(changesBetween({}, { b: 'NEW' })).toEqual([
      { id: 'b', was: '', now: 'NEW' },
    ]);
    expect(changesBetween({ c: 'GONE' }, {})).toEqual([
      { id: 'c', was: 'GONE', now: '' },
    ]);
  });
});

describe('the record of a run', () => {
  it('writes the steps and edits as links notation that parses back', () => {
    withTrace((trace) => {
      trace.step(1, 'form', { moment: 'opened' });
      trace.changes(1, [{ id: 'basic_ttcnHo', was: '', now: 'PLACEHOLDER' }]);
      trace.step(1, 'review', { moment: 'reached' });
      const text = trace.read(1);
      expect(text.includes('(step form')).toBe(true);
      expect(text.includes('(by bot)')).toBe(true);
      expect(text.includes('(step review')).toBe(true);
      // The record is only worth keeping if it reads back.
      expect(readTrace(text, notation).length).toBe(3);
    });
  });

  it('says who made each edit, so a hand-made one can be learned from', () => {
    withTrace((trace) => {
      trace.changes(2, [{ id: 'x', was: 'a', now: 'b' }], 'applicant');
      expect(trace.read(2).includes('(by applicant)')).toBe(true);
    });
  });

  it('keeps a value the notation would otherwise break on', () => {
    withTrace((trace) => {
      trace.changes(3, [
        { id: 'x', was: '', now: "O'Brien (Ward), Nha Trang" },
      ]);
      const parsed = readTrace(trace.read(3), notation);
      expect(parsed.length).toBe(1);
    });
  });

  it('never writes a captcha code down', () => {
    withTrace((trace) => {
      trace.changes(4, [{ id: 'basic_captcha', was: '', now: 'A1B2C3' }]);
      const text = trace.read(4);
      expect(text.includes('A1B2C3')).toBe(false);
      expect(text.includes('withheld')).toBe(true);
    });
  });

  it('writes nothing at all when values are being withheld', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-trace-off-'));
    try {
      const trace = openTrace(dir, { enabled: false, notation });
      trace.step(5, 'form');
      expect(trace.read(5)).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets a run go on when the notation is not there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-trace-bare-'));
    try {
      const trace = openTrace(dir, { notation: null });
      // The point is that this does not throw: a missing record must never
      // stop an application being made.
      trace.step(6, 'form');
      trace.changes(6, [{ id: 'x', was: '', now: 'y' }]);
      expect(trace.read(6)).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sweeps a trace older than the retention, and keeps a fresh one', () => {
    withTrace((trace, dir) => {
      trace.step(7, 'form');
      const old = path.join(dir, 'chat-8.lino');
      fs.writeFileSync(old, '(step form)\n');
      const longAgo = Date.now() - 5 * 86400000;
      fs.utimesSync(old, longAgo / 1000, longAgo / 1000);
      expect(sweepTraces(dir, 1)).toBe(1);
      expect(fs.existsSync(old)).toBe(false);
      expect(trace.read(7).length > 0).toBe(true);
    });
  });

  it('names the steps an application passes, in order', () => {
    expect(STEPS[0]).toBe('form');
    expect(STEPS[STEPS.length - 1]).toBe('paid');
    expect(STEPS.includes('payment')).toBe(true);
  });
});
