import { describe, it, expect } from 'test-anywhere';
import { readFileSync, readdirSync } from 'node:fs';

const ignoreRules = readFileSync('.gitignore', 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => ({
    negated: line.startsWith('!'),
    pattern: line.replace(/^!/, ''),
  }));

/**
 * Reports whether .gitignore covers a path.
 *
 * The patterns are read directly, so the test needs no subprocess and runs
 * under every runtime in the matrix, including Deno's sandbox.
 */
const matchesPattern = (pattern, name) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/(?<!\.)\*/g, '[^/]*')}$`
  ).test(name);

const ruleMatches = ({ pattern }, candidate) => {
  // A leading slash anchors the pattern to the repository root.
  const anchored = pattern.startsWith('/');
  const cleaned = anchored ? pattern.slice(1) : pattern;
  // A trailing slash marks a directory, covering everything beneath it.
  if (cleaned.endsWith('/')) {
    return candidate.startsWith(cleaned);
  }
  if (anchored || cleaned.includes('/')) {
    return matchesPattern(cleaned, candidate);
  }
  // An unanchored bare name matches any path segment, so a directory such as
  // "coverage" also covers everything inside it.
  return candidate.split('/').some((part) => matchesPattern(cleaned, part));
};

const gitIgnores = (candidate) => {
  // The last matching rule wins, so a later "!" line re-includes a path.
  let ignored = false;
  for (const rule of ignoreRules) {
    if (ruleMatches(rule, candidate)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
};

describe('e-visa output stays out of the repository', () => {
  // Everything this tool produces is derived from someone's passport: the
  // filled-form screenshot, the prepared images, the resolved record.
  it('ignores the default output directory', () => {
    expect(gitIgnores('evisa-output/evisa-form.png')).toBe(true);
    expect(gitIgnores('evisa-output/passport.jpg')).toBe(true);
    expect(gitIgnores('evisa-output/portrait.jpg')).toBe(true);
  });

  it('ignores screenshots and prepared images left in the working tree', () => {
    expect(gitIgnores('evisa-form.png')).toBe(true);
    expect(gitIgnores('evisa-filled-form.png')).toBe(true);
    expect(gitIgnores('evisa-passport.jpg')).toBe(true);
  });

  it('ignores resolved applicant records in both supported formats', () => {
    expect(gitIgnores('applicant.json')).toBe(true);
    expect(gitIgnores('applicant.lino')).toBe(true);
    expect(gitIgnores('applicant.evisa.json')).toBe(true);
    expect(gitIgnores('applicant.evisa.lino')).toBe(true);
  });

  it('ignores browser automation scratch output', () => {
    expect(gitIgnores('.playwright-mcp/page.yml')).toBe(true);
  });
});

describe('no personal data is committed', () => {
  const sources = readdirSync('src')
    .filter((f) => f.startsWith('evisa-'))
    .map((f) => ({ file: f, text: readFileSync(`src/${f}`, 'utf8') }));

  const tests = readdirSync('tests')
    .filter((f) => f.startsWith('evisa-'))
    .map((f) => ({ file: f, text: readFileSync(`tests/${f}`, 'utf8') }));

  it('ships no real passport numbers', () => {
    // The only passport numbers in the tree are the documented test value and
    // the obvious placeholder used in the live-form check.
    for (const { file, text } of [...sources, ...tests]) {
      const found = text.match(/\b\d{9}\b/g) ?? [];
      const unexpected = found.filter((n) => n !== '712345678');
      expect(`${file}:${unexpected.join(',')}`).toBe(`${file}:`);
    }
  });

  it('uses placeholder names in fixtures, never anyone real', () => {
    // Test fixtures are built from neutral placeholders so that no real
    // traveller's name is published with the package.
    const allowed = [
      'TRAVELLER',
      'SAMPLE',
      'DOE',
      'JOHN',
      'JANE',
      'ALEX',
      'EXAMPLE',
      'JOSE',
      'ANGEL',
      'ONLY',
      'CORRECT',
      'MISREAD',
      'KEEP',
      'NEW',
      'MOSCOW',
    ];
    for (const { file, text } of tests) {
      // Look at the fields that carry a person's name, so unrelated all-caps
      // fixtures such as a malformed MRZ line are not treated as names.
      const values = [
        ...text.matchAll(
          /(?:surname|givenName|given|last_name|first_name|'First Name'|emergencyName|normalizeName\()\s*:?\s*'([^']+)'/g
        ),
      ].map((m) => m[1]);
      const unexpected = values.filter(
        (value) =>
          !value
            .split(/[\s,]+/)
            .filter(Boolean)
            .every((part) => {
              const plain = part
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toUpperCase();
              // Single letters are placeholders in merge and override tests.
              return plain.length === 1 || allowed.includes(plain);
            })
      );
      expect(`${file}:${[...new Set(unexpected)].join(',')}`).toBe(`${file}:`);
    }
  });

  it('uses only example.com addresses', () => {
    for (const { file, text } of [...sources, ...tests]) {
      const emails = text.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? [];
      const real = emails.filter((e) => !e.endsWith('@example.com'));
      expect(`${file}:${real.join(',')}`).toBe(`${file}:`);
    }
  });

  it('reads documents from paths given at run time, never a hard-coded one', () => {
    for (const { file, text } of sources) {
      expect(`${file}:${text.includes('/Users/')}`).toBe(`${file}:false`);
      expect(`${file}:${text.includes('travel-documents')}`).toBe(
        `${file}:false`
      );
    }
  });

  it('never sends applicant data anywhere but the government form', () => {
    for (const { file, text } of sources) {
      // The bot fetches from Telegram, which is where its documents come from
      // and where its replies go; it is the applicant's own chat, so that one
      // host is allowed. Everything else makes no outbound request at all.
      const allowsTelegram = file === 'evisa-bot-run.mjs';
      if (!allowsTelegram) {
        expect(`${file}:${/\bfetch\s*\(/.test(text)}`).toBe(`${file}:false`);
      }
      expect(`${file}:${/axios|node-fetch|https?\.request/.test(text)}`).toBe(
        `${file}:false`
      );
    }
  });

  it('only ever fetches from Telegram in the bot', () => {
    const bot = readFileSync('src/evisa-bot-run.mjs', 'utf8');
    const urls = bot.match(/https?:\/\/[^\s'"`$]+/g) ?? [];
    for (const url of urls) {
      expect(
        url.startsWith('https://api.telegram.org/') ||
          url.startsWith('https://evisa.gov.vn/')
      ).toBe(true);
    }
  });

  it('keeps nothing about an applicant after their chat ends', () => {
    const bot = readFileSync('src/evisa-bot-run.mjs', 'utf8');
    // Documents live in temporary directories that are removed, and the
    // session is dropped; nothing is written to a lasting location.
    expect(bot.includes('sessions.clear(chatId)')).toBe(true);
    expect(bot.includes('rmSync')).toBe(true);
    expect(/writeFileSync\(\s*['"`][^'"`]*(?:data|home|Users)/.test(bot)).toBe(
      false
    );
  });

  it('only ever navigates to the official e-visa site', () => {
    const fill = readFileSync('src/evisa-fill.mjs', 'utf8');
    const urls = fill.match(/https?:\/\/[^\s'"`]+/g) ?? [];
    for (const url of urls) {
      expect(url.startsWith('https://evisa.gov.vn/')).toBe(true);
    }
  });
});
