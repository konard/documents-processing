import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';
import {
  FIELDS,
  RADIO_GROUPS,
  UPLOADS,
  KNOWN_KEYS,
  AIR_BORDER_GATES,
  PHOTO_RULES,
  MAX_EVISA_DAYS,
  countryName,
  sexLabel,
} from '../src/evisa-schema.mjs';
import { parseArgs } from '../src/evisa-apply.mjs';

describe('evisa schema', () => {
  it('gives every text field a distinct element id', () => {
    const ids = Object.values(FIELDS).map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses the basic_ id prefix the live form assigns', () => {
    for (const [key, field] of Object.entries(FIELDS)) {
      expect(`${key}:${field.id.startsWith('basic_')}`).toBe(`${key}:true`);
    }
  });

  it('only uses the three fill strategies the filler implements', () => {
    for (const field of Object.values(FIELDS)) {
      expect(['text', 'date', 'select'].includes(field.kind)).toBe(true);
    }
  });

  it('marks the fields the application cannot be submitted without', () => {
    const required = Object.entries(FIELDS)
      .filter(([, f]) => f.required)
      .map(([k]) => k);
    for (const key of [
      'surname',
      'givenName',
      'dateOfBirth',
      'nationality',
      'passportNumber',
      'entryBorderGate',
    ]) {
      expect(`${key}:${required.includes(key)}`).toBe(`${key}:true`);
    }
  });

  it('offers a default answer for every radio group', () => {
    for (const [key, group] of Object.entries(RADIO_GROUPS)) {
      expect(`${key}:${group.options.includes(group.default)}`).toBe(
        `${key}:true`
      );
    }
  });

  it('covers all known keys across fields, radios and uploads', () => {
    const total =
      Object.keys(FIELDS).length +
      Object.keys(RADIO_GROUPS).length +
      Object.keys(UPLOADS).length;
    expect(KNOWN_KEYS.size).toBe(total);
  });

  it('spells the air border gates the way the form does', () => {
    // Taken from the live dropdown, which uses different names from the
    // instruction page and accepts only its own.
    expect(AIR_BORDER_GATES.includes('Noi Bai Int Airport')).toBe(true);
    expect(
      AIR_BORDER_GATES.includes('Tan Son Nhat Int Airport (Ho Chi Minh City)')
    ).toBe(true);
    expect(new Set(AIR_BORDER_GATES).size).toBe(AIR_BORDER_GATES.length);
  });

  it('records the photo rules quoted from the instruction page', () => {
    expect(PHOTO_RULES.sizeCm).toBe('4x6');
    expect(PHOTO_RULES.maxBytes).toBe(2 * 1024 * 1024);
    expect(MAX_EVISA_DAYS).toBe(90);
  });
});

describe('passport MRZ conversion', () => {
  it('expands nationality codes to the names the dropdown lists', () => {
    expect(countryName('RUS')).toBe('Russia');
    expect(countryName('rus')).toBe('Russia');
  });

  it('passes through a code it does not know', () => {
    expect(countryName('ZZZ')).toBe('ZZZ');
    expect(countryName(null)).toBe(null);
  });

  it('maps the MRZ sex character to the form wording', () => {
    expect(sexLabel('M')).toBe('Male');
    expect(sexLabel('F')).toBe('Female');
    expect(sexLabel('')).toBe(null);
  });
});

describe('upload preparation', () => {
  const source = readFileSync('src/evisa-passport.mjs', 'utf8');

  it('uploads an image that already fits the limit byte for byte', () => {
    expect(source.includes('fs.copyFileSync(source, outputPath)')).toBe(true);
    expect(source.includes('unchanged: true')).toBe(true);
  });

  it('never crops or enlarges an image', () => {
    // A passport photo is already framed head-and-shoulders, and that framing
    // is part of what a reviewer checks. Cropping to a fixed aspect cuts into
    // it, and enlarging a small scan only loses detail.
    expect(source.includes("fit: 'cover'")).toBe(false);
    expect(source.includes("position: 'attention'")).toBe(false);
    expect(source.includes("fit: 'inside'")).toBe(true);
    expect(source.includes('withoutEnlargement: true')).toBe(true);
  });
});

describe('parseArgs', () => {
  it('collects repeated inputs', () => {
    const options = parseArgs(['--input', 'a.json', '--input', 'b.lino']);
    expect(options.inputs).toEqual(['a.json', 'b.lino']);
  });

  it('treats bare paths as inputs', () => {
    expect(parseArgs(['folder/']).inputs).toEqual(['folder/']);
  });

  it('reads the upload and output paths', () => {
    const options = parseArgs([
      '--portrait',
      'p.jpg',
      '--passport',
      'd.jpg',
      '--out',
      'build',
    ]);
    expect(options.portrait).toBe('p.jpg');
    expect(options.passport).toBe('d.jpg');
    expect(options.out).toBe('build');
  });

  it('keeps the browser open unless asked not to', () => {
    expect(parseArgs([]).keepOpen).toBe(true);
    expect(parseArgs(['--no-keep-open']).keepOpen).toBe(false);
  });

  it('defaults to filling for real, with the flags off', () => {
    const options = parseArgs([]);
    expect(options.dryRun).toBe(false);
    expect(options.ocr).toBe(false);
    expect(options.screenshot).toBe(false);
  });

  it('turns on each flag when passed', () => {
    const options = parseArgs([
      '--dry-run',
      '--ocr',
      '--screenshot',
      '--emit-lino',
    ]);
    expect(options.dryRun).toBe(true);
    expect(options.ocr).toBe(true);
    expect(options.screenshot).toBe(true);
    expect(options.emitLino).toBe(true);
  });
});

describe('submission safety', () => {
  // The tool prefills the declaration and hands control back to the applicant.
  // Clicking submit would sign a legal declaration on their behalf, so no code
  // path may do it.
  const sources = [
    'src/evisa-fill.mjs',
    'src/evisa-apply.mjs',
    'src/evisa-schema.mjs',
  ].map((file) => readFileSync(file, 'utf8'));

  it('never clicks a submit or payment control', () => {
    for (const text of sources) {
      expect(/click\(\s*['"`][^'"`]*[Ss]ubmit/.test(text)).toBe(false);
      expect(/has-text\(\s*["']Submit/.test(text)).toBe(false);
      expect(/has-text\(\s*["']Payment/.test(text)).toBe(false);
    }
  });

  it('runs the browser headed so the applicant can see the form', () => {
    const apply = readFileSync('src/evisa-apply.mjs', 'utf8');
    expect(apply.includes('headless: false')).toBe(true);
  });

  it('says plainly that the form was not submitted', () => {
    const apply = readFileSync('src/evisa-apply.mjs', 'utf8');
    expect(apply.includes('NOT submitted')).toBe(true);
  });
});
