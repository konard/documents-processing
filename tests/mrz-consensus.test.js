import { describe, it, expect } from 'test-anywhere';
import {
  consensus,
  trimNameFiller,
  describeConsensus,
  tieredConsensus,
  namesAgree,
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

  it('keeps a name whose own letters repeat', () => {
    // A doubled letter inside a name is not padding.
    expect(trimNameFiller('ANNA')).toBe('ANNA');
    expect(trimNameFiller('JOANNA')).toBe('JOANNA');
  });
});

describe('namesAgree', () => {
  it('treats the same reading with different filler as agreement', () => {
    // Engines render the MRZ's `<` padding differently; all of these are the
    // same name.
    expect(namesAgree('MARTIN', 'MARTIN')).toBe(true);
    expect(namesAgree('MARTIN', 'MARTINS')).toBe(true);
    expect(namesAgree('MARTIN', 'MARTIN      K KSKKKKKKEKKS')).toBe(true);
    expect(namesAgree('JANE', 'JANEKKKK')).toBe(true);
  });

  it('still tells genuinely different names apart', () => {
    expect(namesAgree('DOE', 'ROE')).toBe(false);
    expect(namesAgree('JOHN', 'JOHN JAMES')).toBe(false);
    expect(namesAgree('ANNA', 'ANNABELLE')).toBe(false);
  });

  it('reports no agreement when a reading is missing', () => {
    expect(namesAgree('DOE', '')).toBe(false);
    expect(namesAgree('', 'DOE')).toBe(false);
  });
});

describe('consensus', () => {
  const agreeing = {
    a: { documentNumber: '123456789', birthDate: '1991-04-05' },
    b: { documentNumber: '123456789', birthDate: '1991-04-05' },
    c: { documentNumber: '123456789', birthDate: '1991-04-05' },
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
    expect(result.data.birthDate).toBe('1991-04-05');
    expect(result.agreement.birthDate.votes).toBe(3);
  });

  it('leaves an even split unresolved', () => {
    const result = consensus(
      {
        a: { birthDate: '1991-04-05' },
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
        c: { surname: 'DOES' },
      },
      { fields: ['surname'] }
    );
    // All three read the same name; only the leftover filler differs.
    expect(result.agreement.surname.votes).toBe(3);
    expect(result.data.surname).toBe('DOE');
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
      '1234567897UTO9104059M3001019<<<<<<<<<<<<<<0',
    ];
    const lines = findMrzLines(page);
    expect(lines.length).toBe(2);
    expect(lines[0].startsWith('P<UTO')).toBe(true);
    expect(lines[1].startsWith('1234567897')).toBe(true);
  });

  it('pads short lines to the TD3 width', () => {
    const lines = findMrzLines([
      'P<UTODOE<<JOHN',
      '1234567897UTO9104059M3001019',
    ]);
    expect(lines[0].length).toBe(44);
    expect(lines[1].length).toBe(44);
  });

  it('accepts a line whose nationality code OCR read as digits', () => {
    // An engine can render a nationality code as digits and still produce a
    // full-length line, which the layout check accepts.
    const lines = findMrzLines([
      'noise',
      '11122233342055120733F2908085<<<<<<<<<<<<<<0',
    ]);
    expect(lines).not.toBe(null);
    expect(lines[1].startsWith('11122233')).toBe(true);
  });

  it('accepts a line the engine truncated after the fields it needs', () => {
    // Some engines stop at the filler; the fixed part is all that is parsed.
    const lines = findMrzLines(['x', '1234567897UTO9104059M3001019<']);
    expect(lines).not.toBe(null);
    expect(lines[1].startsWith('1234567897')).toBe(true);
  });

  it('refuses a line that lost a character, since every field after it shifts', () => {
    // A short data section means OCR dropped a glyph. Padding it would produce
    // a wrong number and a wrong date that both still look plausible.
    const lines = findMrzLines([
      'noise',
      '6967997502058512073F2908085<<<<<<<<<<<<<<02',
    ]);
    expect(lines).toBe(null);
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
      { birthDate: '910405' },
      { birthDate: '1991-04-05' }
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

describe('tieredConsensus', () => {
  const reading = { documentNumber: '123456789', surname: 'DOE' };
  const reader = (name, value, log) => ({
    name,
    read: async () => {
      log.push(name);
      return value;
    },
  });

  it('stops after the fast engines when they already agree', async () => {
    const log = [];
    const result = await tieredConsensus('x.jpg', {
      fast: [reader('a', reading, log), reader('b', reading, log)],
      slow: [reader('slow', reading, log)],
      fields: ['documentNumber', 'surname'],
    });
    expect(result.complete).toBe(true);
    expect(log.includes('slow')).toBe(false);
    expect(result.escalated).toBe(false);
  });

  it('calls the expensive engine when the fast ones disagree', async () => {
    const log = [];
    const result = await tieredConsensus('x.jpg', {
      fast: [
        reader('a', { surname: 'DOE' }, log),
        reader('b', { surname: 'ROE' }, log),
      ],
      slow: [reader('slow', { surname: 'DOE' }, log)],
      fields: ['surname'],
    });
    expect(log.includes('slow')).toBe(true);
    expect(result.escalated).toBe(true);
    // The extra vote breaks the tie.
    expect(result.data.surname).toBe('DOE');
  });

  it('records a reader that threw, and carries on', async () => {
    const log = [];
    const broken = {
      name: 'broken',
      read: async () => {
        throw new Error('engine unavailable');
      },
    };
    const result = await tieredConsensus('x.jpg', {
      fast: [reader('a', reading, log), reader('b', reading, log), broken],
      fields: ['documentNumber'],
    });
    expect(result.failures[0].reader).toBe('broken');
    expect(result.data.documentNumber).toBe('123456789');
  });

  it('reports what is still unsettled after every tier', async () => {
    const log = [];
    const result = await tieredConsensus('x.jpg', {
      fast: [
        reader('a', { surname: 'DOE' }, log),
        reader('b', { surname: 'ROE' }, log),
      ],
      slow: [reader('slow', { surname: 'MOE' }, log)],
      fields: ['surname'],
    });
    expect(result.complete).toBe(false);
    expect(result.disputed[0].field).toBe('surname');
  });
});
