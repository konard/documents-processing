import { describe, it, expect } from 'test-anywhere';
import path from 'node:path';
import {
  classify,
  applyAliases,
  parseLinoFallback,
  toLino,
  walk,
  loadSource,
  guessDocumentRole,
} from '../src/evisa-sources.mjs';

// Fixtures are committed and read-only, so these tests need no write access
// and run under every runtime in the matrix, including Deno's sandbox.
const FIXTURES = 'tests/fixtures/evisa';

describe('classify', () => {
  it('recognizes each supported input type', () => {
    expect(classify('a/b/data.json')).toBe('json');
    expect(classify('data.lino')).toBe('lino');
    expect(classify('scan.JPG')).toBe('image');
    expect(classify('passport.pdf')).toBe('pdf');
    expect(classify('bundle.zip')).toBe('archive');
  });

  it('reports anything else as unknown', () => {
    expect(classify('notes.txt')).toBe('unknown');
    expect(classify('README')).toBe('unknown');
  });
});

describe('applyAliases', () => {
  it('maps the common spellings of each field onto schema keys', () => {
    const out = applyAliases({
      last_name: 'DOE',
      'First Name': 'JANE',
      DOB: '1990-01-01',
      passport_no: 'ABC123',
      date_of_expiry: '2030-01-01',
    });
    expect(out.surname).toBe('DOE');
    expect(out.givenName).toBe('JANE');
    expect(out.dateOfBirth).toBe('1990-01-01');
    expect(out.passportNumber).toBe('ABC123');
    expect(out.passportExpiryDate).toBe('2030-01-01');
  });

  it('leaves keys that are already schema keys untouched', () => {
    const out = applyAliases({
      entryBorderGate: 'Noi Bai Airport Border Gate',
    });
    expect(out.entryBorderGate).toBe('Noi Bai Airport Border Gate');
  });

  it('camel-cases unrecognized snake_case keys', () => {
    expect(applyAliases({ some_new_field: 1 }).someNewField).toBe(1);
  });

  it('keeps the underscore on comment keys so they stay recognizable', () => {
    // Without this, _comment becomes Comment and is reported as an unknown
    // field every time the shipped example is used.
    const out = applyAliases({ _comment: 'notes', surname: 'X' });
    expect('_comment' in out).toBe(true);
    expect('Comment' in out).toBe(false);
  });
});

describe('the shipped example applicant', () => {
  it('resolves and validates with no errors', async () => {
    const [source] = await loadSource('examples/evisa-applicant.example.json');
    const { normalizeApplicant, validateApplicant } =
      await import('../src/evisa-data.mjs');
    const result = validateApplicant(normalizeApplicant(source.data));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('rewrites its instruction-page wording to what the form accepts', async () => {
    const [source] = await loadSource('examples/evisa-applicant.example.json');
    const { normalizeApplicant } = await import('../src/evisa-data.mjs');
    const applicant = normalizeApplicant(source.data);
    expect(applicant.purpose).toBe('Tourist');
    expect(applicant.entryBorderGate).toBe('Noi Bai Int Airport');
  });
});

describe('lino round trip', () => {
  it('encodes a record and reads it back unchanged', () => {
    const record = {
      surname: 'EXAMPLE',
      givenName: 'ALEX',
      passportNumber: '712345678',
    };
    expect(parseLinoFallback(toLino(record))).toEqual(record);
  });

  it('preserves booleans through the round trip', () => {
    const parsed = parseLinoFallback(toLino({ visitedVietnamLastYear: true }));
    expect(parsed.visitedVietnamLastYear).toBe(true);
  });

  it('keeps values that contain spaces intact', () => {
    const parsed = parseLinoFallback(
      toLino({ entryBorderGate: 'Noi Bai Airport Border Gate' })
    );
    expect(parsed.entryBorderGate).toBe('Noi Bai Airport Border Gate');
  });
});

describe('walk', () => {
  it('finds nested files and skips dotfiles and resource forks', () => {
    const found = walk(FIXTURES)
      .map((f) => path.basename(f))
      .sort();
    expect(found.includes('applicant.json')).toBe(true);
    expect(found.includes('nested.json')).toBe(true);
    expect(found.includes('.hidden.json')).toBe(false);
    expect(found.includes('resource.json')).toBe(false);
  });
});

describe('loadSource', () => {
  it('reads a JSON file and normalizes its keys', async () => {
    const [source] = await loadSource(`${FIXTURES}/applicant.json`);
    expect(source.kind).toBe('json');
    expect(source.data.surname).toBe('DOE');
    expect(source.data.givenName).toBe('JOHN');
  });

  it('unwraps a record nested under an "applicant" key', async () => {
    const [source] = await loadSource(`${FIXTURES}/wrapped.json`);
    expect(source.data.surname).toBe('SAMPLE');
  });

  it('reads a lino file', async () => {
    const [source] = await loadSource(`${FIXTURES}/applicant.lino`);
    expect(source.kind).toBe('lino');
    expect(source.data.surname).toBe('TRAVELLER');
  });

  it('returns an image as a document reference, leaving it unparsed', async () => {
    const file = `${FIXTURES}/SAMPLE-PASSPORT.jpg`;
    const [source] = await loadSource(file);
    expect(source.kind).toBe('image');
    expect(source.documentPath).toBe(file);
    expect(source.data).toEqual({});
  });

  it('loads every recognized file in a folder, skipping the rest', async () => {
    const sources = await loadSource(FIXTURES);
    const kinds = sources.map((s) => s.kind).sort();
    // Three JSON files, one lino record and one image; notes.txt is skipped.
    expect(kinds).toEqual(['image', 'json', 'json', 'json', 'lino']);
  });
});

describe('guessDocumentRole', () => {
  it('routes each document by its filename', () => {
    expect(guessDocumentRole('/x/SAMPLE-PHOTO.jpg')).toBe('portrait');
    expect(guessDocumentRole('/x/SAMPLE-PASSPORT.jpg')).toBe('passport');
    expect(guessDocumentRole('/x/TRAVELLER-VIETNAM-VISA.pdf')).toBe('visa');
    expect(guessDocumentRole('/x/scan001.jpg')).toBe('unknown');
  });

  it('treats a passport photo as the passport page, not the portrait', () => {
    expect(guessDocumentRole('/x/PASSPORT-PHOTO.jpg')).toBe('passport');
  });
});
