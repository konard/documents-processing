import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';
import {
  spellingsOf,
  valuesToRedact,
  redactText,
  replacementsFile,
  worthSearching,
  chooseFiles,
  REDACTED,
} from '../src/evisa-redact.mjs';

describe('finding every way a value is written', () => {
  it('finds a phone number however it is grouped', () => {
    // Written 123-45-67 in one place and 1234567 in another, it is one
    // number, and redacting one spelling leaves the other published.
    const spellings = spellingsOf('123-45-67');
    expect(spellings.includes('123-45-67')).toBe(true);
    expect(spellings.includes('1234567')).toBe(true);
  });

  it('finds a date in the orders it gets written in', () => {
    const spellings = spellingsOf('1990-02-01');
    expect(spellings.includes('01/02/1990')).toBe(true);
    expect(spellings.includes('01.02.1990')).toBe(true);
  });

  it('finds a name in upper and lower case', () => {
    const spellings = spellingsOf('Sample');
    expect(spellings.includes('SAMPLE')).toBe(true);
    expect(spellings.includes('sample')).toBe(true);
  });

  it('leaves a value too short to mean anything on its own', () => {
    // "Li" matches half the source; redacting it would redact the code.
    expect(spellingsOf('Li')).toEqual([]);
    expect(spellingsOf('')).toEqual([]);
    expect(spellingsOf(undefined)).toEqual([]);
  });

  it('takes a short value when it is named on purpose', () => {
    // Given explicitly, the caller has decided; a reading has not.
    expect(valuesToRedact({}, ['abc']).includes('abc')).toBe(true);
  });
});

describe('reading a passport for what identifies somebody', () => {
  it('takes the fields that name a person, not the rest', () => {
    const values = valuesToRedact({
      surname: 'TRAVELLER',
      givenName: 'SAMPLE',
      passportNumber: 'AB1234567',
      nationality: 'Russian Federation',
      sex: 'Male',
    });
    expect(values.includes('TRAVELLER')).toBe(true);
    expect(values.includes('AB1234567')).toBe(true);
    // A nationality and a sex identify nobody on their own, and redacting
    // them would take the word "Male" out of the source.
    expect(values.includes('Russian Federation')).toBe(false);
    expect(values.includes('Male')).toBe(false);
  });

  it('puts the longest first, so no fragment is orphaned', () => {
    // Redacting "SAMPLE" before "SAMPLE STREET 12" would leave
    // "[REDACTED] STREET 12" with the address still legible.
    const values = valuesToRedact({
      surname: 'SAMPLE',
      permanentAddress: 'SAMPLE STREET 12',
    });
    expect(values[0].length >= values[values.length - 1].length).toBe(true);
    const { text } = redactText('at SAMPLE STREET 12 today', values);
    expect(text.includes('STREET')).toBe(false);
  });
});

describe('taking the values out of a piece of text', () => {
  it('replaces every spelling it finds, and counts them', () => {
    const { text, removed } = redactText('TRAVELLER and traveller', [
      'TRAVELLER',
    ]);
    expect(text).toBe(`${REDACTED} and ${REDACTED}`);
    expect(removed).toBe(2);
  });

  it('leaves text holding none of them exactly as it was', () => {
    const said = 'const form = await openForm({ headless: true });';
    expect(redactText(said, ['TRAVELLER']).text).toBe(said);
    expect(redactText(said, ['TRAVELLER']).removed).toBe(0);
  });

  it('treats a value with regex characters as the literal it is', () => {
    // An address such as "406/14 Cong Hoa" holds a slash, and a phone a
    // "+"; taken as a pattern they would match the wrong things or throw.
    const { text } = redactText('at 406/14 Cong Hoa now', ['406/14 Cong Hoa']);
    expect(text).toBe(`at ${REDACTED} now`);
    expect(redactText('a+b', ['a+b']).text).toBe(REDACTED);
  });

  it('writes the replacement list git reads', () => {
    const written = replacementsFile(['SAMPLE']);
    expect(written).toBe(`literal:SAMPLE==>${REDACTED}\n`);
  });
});

describe('choosing which files a run may change', () => {
  it('matches a name anywhere when the pattern names no directory', () => {
    // "*.test.js" reads as every test, wherever it sits.
    const chosen = chooseFiles({ only: ['*.test.js'] });
    expect(chosen('tests/a.test.js')).toBe(true);
    expect(chosen('deep/down/b.test.js')).toBe(true);
    expect(chosen('src/a.mjs')).toBe(false);
  });

  it('matches a whole path when the pattern names one', () => {
    const chosen = chooseFiles({ only: ['src/**'] });
    expect(chosen('src/a.mjs')).toBe(true);
    expect(chosen('src/deep/b.mjs')).toBe(true);
    expect(chosen('tests/a.test.js')).toBe(false);
  });

  it('takes files back out, which is the point of the whole thing', () => {
    // A surname is personal data where the application uses it and a public
    // name where a transliteration test does. One word, two answers, and the
    // only thing that can tell them apart is which file it is in.
    const chosen = chooseFiles({ except: ['tests/translit.test.js'] });
    expect(chosen('tests/translit.test.js')).toBe(false);
    expect(chosen('tests/other.test.js')).toBe(true);
  });

  it('excludes a whole directory, for work nobody wants rewritten', () => {
    const chosen = chooseFiles({ except: ['docs/case-studies/**'] });
    expect(chosen('docs/case-studies/issue-3/data.json')).toBe(false);
    expect(chosen('docs/EVISA.md')).toBe(true);
  });

  it('leaves a picture alone whatever the patterns say', () => {
    // Rewriting a PNG by pattern corrupts it, and that is about the bytes,
    // not about anyone's choice.
    const chosen = chooseFiles({ only: ['**'] });
    expect(chosen('docs/passport.png')).toBe(false);
  });

  it('takes everything when nothing is named', () => {
    const chosen = chooseFiles();
    expect(chosen('anything.md')).toBe(true);
  });
});

describe('values that must survive a run', () => {
  it('refuses a run that would redact something named as kept', async () => {
    // A spelling rule reaches further than the value it was given. Asked for
    // a surname it takes the upper-case form too, and a public nickname that
    // contains it would go with it.
    const { keptValuesAreSafe } = await import('../src/redact-history.mjs');
    expect(keptValuesAreSafe(['SAMPLE'], ['a public nickname'])).toEqual([]);
    // Named as kept, but a value in the list is inside it.
    expect(keptValuesAreSafe(['SAMPLE'], ['SAMPLETON'])).toEqual(['SAMPLETON']);
  });

  it('sees a match in any case, since redaction ignores case', () => {
    expect(redactText('sampleton', ['SAMPLE']).removed).toBe(1);
  });
});

describe('checking a repository after a rewrite', () => {
  it('asks what commits hold, not what they changed', () => {
    // A diff search matches a commit for taking a value out as readily as
    // for putting it in, so a finished rewrite named every commit it had
    // just mended and read as having done nothing at all. What matters is
    // whether any tree still contains the value.
    const tool = readFileSync('src/redact-history.mjs', 'utf8');
    const at = tool.indexOf('function commitsHolding');
    const body = tool.slice(at, tool.indexOf('\n}\n', at));
    expect(body.includes("'grep'")).toBe(true);
    expect(body.includes('-G')).toBe(false);
  });

  it('leaves the undo refs out of the search', () => {
    // filter-branch keeps the history as it was under refs/original so a
    // rewrite can be undone. Searching those reports the leak for ever.
    const tool = readFileSync('src/redact-history.mjs', 'utf8');
    const at = tool.indexOf('function commitsHolding');
    const body = tool.slice(at, tool.indexOf('\n}\n', at));
    expect(body.includes("'--branches', '--remotes'")).toBe(true);
    expect(body.includes("'--all'")).toBe(false);
  });

  it('takes the backup itself, so a run cannot start without one', () => {
    // The ids all change and every clone breaks, so there is one chance to
    // have kept the history as it was. The script takes it.
    const tool = readFileSync('src/redact-history.mjs', 'utf8');
    expect(tool.includes('function takeBackup')).toBe(true);
    expect(tool.includes("'clone', '--mirror'")).toBe(true);
    expect(tool.includes('repo.git')).toBe(true);
  });

  it('proves the rewrite before publishing it', () => {
    // The push is the irreversible half, so nothing reaches the remote on a
    // promise: the history is searched again and the tests are run, and
    // either failing stops the run with nothing pushed.
    const tool = readFileSync('src/redact-history.mjs', 'utf8');
    const at = tool.indexOf('function rewriteAndPublish');
    const body = tool.slice(at, tool.indexOf('\n}\n', at));
    const verified = body.indexOf('commitsHolding(repo, wanted, chosen)');
    const tested = body.indexOf('testsStillPass(repo)');
    const pushed = body.indexOf('pushEverything(repo)');
    expect(verified > -1 && tested > -1 && pushed > -1).toBe(true);
    // Both checks come before the push, and both stop the run.
    expect(verified < pushed).toBe(true);
    expect(tested < pushed).toBe(true);
    expect(body.includes('Nothing was pushed.')).toBe(true);
  });

  it('says what the checked-out tree still holds, before rewriting it', () => {
    // A rewrite replaces a value wherever it stands, fixtures included, and a
    // test left asserting on [REDACTED] has stopped saying anything. So the
    // tree is reported first, for a person to replace by hand with something
    // of the same shape that belongs to nobody.
    const tool = readFileSync('src/redact-history.mjs', 'utf8');
    const at = tool.indexOf('export function treeHolding');
    const body = tool.slice(at, tool.indexOf('\n}\n', at));
    expect(body.includes("'ls-files'")).toBe(true);
    // Redaction ignores case, so the report has to as well, or it names
    // fewer files than the rewrite is about to change.
    expect(body.includes('toLowerCase()')).toBe(true);
    // Reported in the dry run, where it can still be acted on.
    expect(tool.includes('reportTheTree(repo, wanted, chosen)')).toBe(true);
  });

  it('runs the repository´s own tests, not a check of its own', () => {
    // A check written here would drift from what the repository actually
    // requires. What it runs is what anybody runs.
    const tool = readFileSync('src/redact-history.mjs', 'utf8');
    expect(tool.includes("execFileSync('npm', ['test']")).toBe(true);
  });
});

describe('which files are worth searching', () => {
  it('leaves a picture alone, having no text to redact', () => {
    // Rewriting a PNG by pattern corrupts it.
    expect(worthSearching('docs/passport.png')).toBe(false);
    expect(worthSearching('a/b/scan.JPEG')).toBe(false);
    expect(worthSearching('form.pdf')).toBe(false);
  });

  it('searches anything that holds words', () => {
    expect(worthSearching('src/evisa-bot.mjs')).toBe(true);
    expect(worthSearching('data/traces/chat-1.lino')).toBe(true);
    expect(worthSearching('README.md')).toBe(true);
  });
});
