import { describe, it, expect } from 'test-anywhere';
import { execFileSync } from 'node:child_process';
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

/** Everything published: code, tests and the prose beside them. */
function publishedFiles() {
  const inDir = (dir, ext) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => ({
        file: `${dir}/${f}`,
        text: readFileSync(`${dir}/${f}`, 'utf8'),
      }));
  return [
    ...inDir('src', '.mjs'),
    ...inDir('tests', '.js'),
    // Prose is as public as code, and an example in it is just as real.
    ...inDir('docs', '.md'),
    ...inDir('.changeset', '.md'),
    { file: 'README.md', text: readFileSync('README.md', 'utf8') },
  ];
}

describe('the people this was built from are never named', () => {
  it('names none of them, in code, in a comment or in prose', () => {
    // The tool was developed against real travellers' documents. Fixtures use
    // invented people; these names must never reach the public tree.
    // Built from parts so they never appear whole in this file either, which
    // would trip the very check it defines.
    const realPeople = new RegExp(
      [
        'bet' + 'sa',
        'lari' + 'onov',
        'dzhe' + 'ims',
        'ekat' + 'erina',
        'kris' + 'tian',
        'boga' + 'tova',
        'diach' + 'enko',
        'drak' + 'onard',
        'karel' + 'skii',
        'ros' + 'hal',
        'urit' + 'sk',
        // Their streets and postcodes identify them as surely as their names.
        '1274' + '11',
        '1407' + '31',
      ].join('|'),
      'gi'
    );
    for (const { file, text } of publishedFiles()) {
      const hits = [...new Set(text.match(realPeople) ?? [])];
      expect(`${file}:${hits.join(',')}`).toBe(`${file}:`);
    }
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
          /(?:(?:surname|givenName|given|last_name|first_name|'First Name'|emergencyName)\s*:|normalizeName\()\s*'([^']+)'/g
        ),
      ].map((m) => m[1]);
      const unexpected = values.filter(
        (value) =>
          // A hyphen joins two names, "JOHN-ALEX", each a placeholder.
          !value
            .split(/[\s,-]+/)
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
      const allowsTelegram =
        file === 'evisa-bot-run.mjs' || file === 'evisa-details.mjs';
      if (!allowsTelegram) {
        expect(`${file}:${/\bfetch\s*\(/.test(text)}`).toBe(`${file}:false`);
      }
      // A file allowed to fetch may fetch from Telegram and nowhere else: the
      // allowance is for the applicant's own chat, not for the open internet.
      if (allowsTelegram) {
        const hosts = text.match(/https?:\/\/[\w.-]+/g) ?? [];
        const strangers = hosts.filter(
          (host) => !/\/\/(?:api\.)?telegram\.org$/.test(host)
        );
        expect(`${file}:${strangers.join(',')}`).toBe(`${file}:`);
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

  it("writes an applicant's documents only to the temp directory", () => {
    // Documents are kept for diagnosis, so where they land matters: the system
    // clears its temp directory, and nothing else does.
    const bot = readFileSync('src/evisa-bot-run.mjs', 'utf8');
    const helpers = readFileSync('src/evisa-bot.mjs', 'utf8');
    expect(helpers.includes('os.tmpdir()')).toBe(true);
    expect(/writeFileSync\(\s*['"`][^'"`]*(?:home|Users)/.test(bot)).toBe(
      false
    );
    expect(bot.includes('sessions.clear(chatId)')).toBe(true);
  });

  it('clears what it kept on a schedule, so it cannot pile up', () => {
    // A machine left running for weeks would otherwise hold every document it
    // was ever sent.
    const logging = readFileSync('src/evisa-log.mjs', 'utf8');
    expect(logging.includes('RETENTION_DAYS')).toBe(true);
    expect(logging.includes('rmSync')).toBe(true);
    // The sweep only touches directories this tool made, and it names every
    // prefix it uses: one left out accumulates passport images for ever.
    expect(logging.includes('^evisa-(')).toBe(true);
    for (const prefix of [
      'bot',
      'doc',
      'shot',
      'step',
      'slice',
      'markup',
      'ocr',
    ]) {
      expect(`${prefix}:${logging.includes(prefix)}`).toBe(`${prefix}:true`);
    }
  });

  it('says nothing to an applicant about how their documents are handled', () => {
    // A promise that is not kept is worse than none, so the messages make no
    // claim either way.
    const messages = readFileSync('src/evisa-bot.mjs', 'utf8');
    expect(messages.includes('I keep nothing')).toBe(false);
    expect(messages.includes('ничего не сохраняю')).toBe(false);
  });

  it('only ever navigates to the official e-visa site', () => {
    const fill = readFileSync('src/evisa-fill.mjs', 'utf8');
    const urls = fill.match(/https?:\/\/[^\s'"`]+/g) ?? [];
    for (const url of urls) {
      expect(url.startsWith('https://evisa.gov.vn/')).toBe(true);
    }
  });
});

describe('the container keeps the bot self-contained', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  const compose = readFileSync('compose.yaml', 'utf8');

  it('never bakes the token into the image', () => {
    // An image carrying the token would leak it to anyone who pulls it, so the
    // token is only ever supplied at run time.
    expect(dockerfile.includes('EVISA_BOT_TOKEN')).toBe(false);
    expect(compose.includes('env_file')).toBe(true);
    // A literal token in either file would defeat the point.
    expect(/\d{8,}:[A-Za-z0-9_-]{30,}/.test(dockerfile + compose)).toBe(false);
  });

  it('never copies the .env file into the image', () => {
    // `COPY . .` would pull in an un-ignored .env; the copies are explicit.
    expect(/^COPY \. /m.test(dockerfile)).toBe(false);
    expect(dockerfile.includes('.env')).toBe(false);
  });

  it('keeps logs and documents inside the container', () => {
    // Everything an applicant sends stays in one volume, which is what makes it
    // both reachable for diagnosis and removable in one step.
    expect(dockerfile.includes('TMPDIR=/data/tmp')).toBe(true);
    expect(dockerfile.includes('EVISA_BOT_LOG=/data/')).toBe(true);
    expect(compose.includes('/data')).toBe(true);
  });

  it('asks the system where temporary files go', () => {
    // Setting TMPDIR only redirects the documents if the code honours it, which
    // is what puts them in the volume and not the container's own /tmp.
    const bot = readFileSync('src/evisa-bot-run.mjs', 'utf8');
    const logging = readFileSync('src/evisa-log.mjs', 'utf8');
    expect(/mkdtempSync\(\s*path\.join\(\s*['"`]\/tmp/.test(bot)).toBe(false);
    expect(logging.includes("path.join('/tmp'")).toBe(false);
    expect(logging.includes('os.tmpdir()')).toBe(true);
  });

  it('comes back on its own after a crash', () => {
    expect(compose.includes('restart: unless-stopped')).toBe(true);
  });

  it('builds on the Playwright image matching the installed client', () => {
    // The client refuses to drive a browser build it does not recognise, and
    // the mismatch only shows up at run time, on the first page it opens.
    const wanted = JSON.parse(
      readFileSync('package.json', 'utf8')
    ).dependencies.playwright.replace(/^[^\d]*/, '');
    expect(dockerfile.includes(`playwright:v${wanted}`)).toBe(true);
  });

  it('runs the browser as an unprivileged user', () => {
    // Chromium's sandbox refuses to start as root, and running as root would be
    // worth avoiding regardless.
    expect(dockerfile.includes('USER pwuser')).toBe(true);
  });
});

describe('nothing an applicant sent is tracked by git', () => {
  /** Every path git has staged or committed, as git itself reports them. */
  const tracked = () =>
    execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

  it('tracks no run of the bot: no trace, no transcript, no chat store', () => {
    // A trace holds the passport number, the name, the email and the
    // addresses, exactly as the applicant sent them. It was tracked once,
    // because the folder it lives in was made after the ignore rules were
    // written and nobody added it to them. The test is on what git holds,
    // since that is what reaches the published tree.
    const runtime = tracked().filter((path) =>
      /^data\/(traces|transcripts)\/|^data\/chats\.lino/.test(path)
    );
    expect(runtime).toEqual([]);
  });

  it('keeps every runtime folder under data ignored', () => {
    // Each of these holds what an applicant sent. A new one is easy to add
    // and easy to forget, so the rule is checked and not assumed.
    const ignored = readFileSync('.gitignore', 'utf8');
    for (const folder of ['data/traces/', 'data/transcripts/']) {
      expect(`${folder}:${ignored.includes(folder)}`).toBe(`${folder}:true`);
    }
  });

  it('tracks only example files under data', () => {
    // Everything else there is a real applicant's, or is written at runtime.
    const underData = tracked().filter((path) => path.startsWith('data/'));
    const unexpected = underData.filter(
      (path) => !/\.example\.(json|txt)$|^data\/\.env\.example$/.test(path)
    );
    expect(unexpected).toEqual([]);
  });
});
