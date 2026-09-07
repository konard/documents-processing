import { describe, it, expect } from 'test-anywhere';
import {
  consensus,
  trimNameFiller,
  describeConsensus,
} from '../src/mrz-consensus.mjs';
import { scoreReading, summarize } from '../src/mrz-benchmark.mjs';
import { findMrzLines } from '../src/mrz-readers.mjs';

describe('trimNameFiller', () => {
  it('drops the padding OCR reads off the end of a name', () => {
    expect(trimNameFiller('JANEKKKKKKK')).toBe('JANE');
    expect(trimNameFiller('JOHN<<<<<<<')).toBe('JOHN');
  });

  it('leaves a name with no padding alone', () => {
    expect(trimNameFiller('JANE')).toBe('JANE');
  });

  it('keeps a genuine second name', () => {
    expect(trimNameFiller('JOHN JAMES')).toBe('JOHNJAMES');
  });
});

describe('consensus', () => {
  const agreeing = {
    a: { documentNumber: '123456789', birthDate: '[REDACTED]' },
    b: { documentNumber: '123456789', birthDate: '[REDACTED]' },
    c: { documentNumber: '123456789', birthDate: '[REDACTED]' },
  };

  it('accepts a value the engines agree on', () => {
    const result = consensus(agreeing, { fields: ['documentNumber'] });
    expect(result.data.documentNumber).toBe('123456789');
    expect(result.agreement.documentNumber.votes).toBe(3);
  });

  it('outvotes a single engine that read a field wrong', () => {
    // This is the real pattern: engines fail on different fields, so a
    // majority recovers the value none of them gets right every time.
    const result = consensus(
      { ...agreeing, d: { birthDate: '2010-03-02' } },
      { fields: ['birthDate'] }
    );
    expect(result.data.birthDate).toBe('[REDACTED]');
    expect(result.agreement.birthDate.votes).toBe(3);
  });

  it('leaves an even split unresolved', () => {
    const result = consensus(
      {
        a: { birthDate: '[REDACTED]' },
        b: { birthDate: '2010-03-02' },
      },
      { fields: ['birthDate'] }
    );
    expect(result.data.birthDate).toBe(undefined);
    expect(result.disputed[0].field).toBe('birthDate');
    expect(result.complete).toBe(false);
  });

  it('reports a field no engine could read', () => {
    const result = consensus({ a: {}, b: {} }, { fields: ['surname'] });
    expect(result.unread).toEqual(['surname']);
    expect(result.complete).toBe(false);
  });

  it('treats differently formatted values as the same vote', () => {
    const result = consensus(
      {
        a: { documentNumber: '123456789' },
        b: { documentNumber: '12 34 56 789' },
      },
      { fields: ['documentNumber'] }
    );
    expect(result.agreement.documentNumber.votes).toBe(2);
  });

  it('counts names that differ only in OCR padding as agreeing', () => {
    const result = consensus(
      {
        a: { surname: 'DOE' },
        b: { surname: 'DOEKKKKKKKK' },
      },
      { fields: ['surname'] }
    );
    expect(result.agreement.surname.votes).toBe(2);
  });

  it('needs the requested level of agreement', () => {
    const result = consensus(
      { a: { surname: 'DOE' } },
      { fields: ['surname'], minAgreement: 2 }
    );
    expect(result.data.surname).toBe(undefined);
    expect(result.disputed.length).toBe(1);
  });

  it('names each disputed field in its description', () => {
    const result = consensus(
      { a: { surname: 'DOE' }, b: { surname: 'ROE' } },
      { fields: ['surname'] }
    );
    const text = describeConsensus(result).join('\n');
    expect(text.includes('DISPUTED surname')).toBe(true);
    expect(text.includes('check this by hand')).toBe(true);
  });
});

describe('findMrzLines', () => {
  it('picks the two MRZ lines out of a full page of text', () => {
    const page = [
      'RUSSIAN FEDERATION',
      'Date of birth',
      'P<UTODOE<<JOHN<<<<<<<<<<<<<<<',
      '1234567897UTO9003026M3001019<<<<<<<<<<<<<<0',
    ];
    const lines = findMrzLines(page);
    expect(lines.length).toBe(2);
    expect(lines[0].startsWith('P<UTO')).toBe(true);
    expect(lines[1].startsWith('1234567897')).toBe(true);
  });

  it('pads short lines to the TD3 width', () => {
    const lines = findMrzLines([
      'P<UTODOE<<JOHN',
      '1234567897UTO9003026M3001019',
    ]);
    expect(lines[0].length).toBe(44);
    expect(lines[1].length).toBe(44);
  });

  it('still finds line two when OCR drops the nationality code', () => {
    // Seen in practice: an engine merged the letters away, and a strict
    // field-layout match would have rejected an otherwise good read.
    const lines = findMrzLines([
      'noise',
      '1112223334445556073F2908085<<<<<<<<<<<<<<02',
    ]);
    expect(lines).not.toBe(null);
    expect(lines[1].startsWith('11122233')).toBe(true);
  });

  it('returns null when there is no MRZ', () => {
    expect(findMrzLines(['just', 'some words'])).toBe(null);
  });
});

describe('benchmark scoring', () => {
  it('counts a field right only when it matches', () => {
    const score = scoreReading(
      { documentNumber: '123456789', surname: 'DOE' },
      { documentNumber: '123456789', surname: 'ROE' }
    );
    expect(score.correct).toBe(1);
    expect(score.attempted).toBe(2);
  });

  it('accepts a six-digit MRZ date against a full date', () => {
    const score = scoreReading(
      { birthDate: '900302' },
      { birthDate: '[REDACTED]' }
    );
    expect(score.correct).toBe(1);
  });

  it('accepts a name that carries OCR padding', () => {
    const score = scoreReading({ surname: 'DOEKKKKKKK' }, { surname: 'DOE' });
    expect(score.correct).toBe(1);
  });

  it('summarizes accuracy and timing across images', () => {
    const row = summarize('demo', [
      { ms: 100, error: null, correct: 5, attempted: 5, fields: {} },
      { ms: 300, error: null, correct: 4, attempted: 5, fields: {} },
    ]);
    expect(row.correct).toBe(9);
    expect(row.attempted).toBe(10);
    expect(row.accuracy).toBe(0.9);
    expect(row.perfectImages).toBe(1);
    expect(row.totalMs).toBe(400);
  });
});
