#!/usr/bin/env node
// redact-history.mjs
//
// Takes personal data out of every commit in the repository's history.
//
// The values come from a passport, read the way the bot reads one, and from
// a file of anything else that should never have been published: addresses,
// phone numbers, an email. Nothing personal is written in this file, so it
// can live in the public tree.
//
// Commits are kept. Every one holds its place, its message, its author and
// its date; every file that ever existed still exists at every version it
// had. Only the values inside them become [REDACTED]. The history stays
// readable as the record of how the work was done.
//
// One decision is left to a person: what counts as personal data. Everything
// after it the script does — reading the values, choosing the files, taking
// the backup, rewriting, checking the result, and pushing.
//
// Usage:
//   node src/redact-history.mjs --config <file>           what would change
//   node src/redact-history.mjs --config <file> --write   rewrite and check
//   node src/redact-history.mjs --config <file> --write --push
//
//   --repo <path>     which repository, default the one this lives in
//   --config <file>   JSON: values, passports, only, except, keep (below)
//   --passport <img>  a passport page, read for the values it holds
//   --values <file>   more values, one a line, kept outside the repository
//   --write           rewrite; without it nothing is changed
//   --push            force-push every branch after a rewrite that verified
//   --force           rewrite without a backup beside the repository
//
// The config is JSON and lives outside the repository, because it names the
// values:
//
//   {
//     "values": ["<a value>", "<another spelling of it>"],
//     "valuesFile": "values.txt",
//     "passports": [
//       "scan.jpg",
//       { "file": "mine.jpg", "skip": ["surname", "givenName"] }
//     ],
//     "only": ["src/**", "tests/**"],
//     "except": ["docs/case-studies/**", "tests/translit.test.js"],
//     "keep": ["a public nickname", "a public place name"]
//   }
//
// `only` and `except` are globs, and they are the answer to a word that is
// personal data in one file and not in another: a surname is data where the
// application uses it and a public name where a transliteration test does.
//
// A passport given with `skip` is read without those fields, for a person
// whose name is public though their passport number and dates are not.
//
// `keep` names values that must survive, and is checked against the list, so
// a nickname cannot be redacted by a spelling rule that reached too far.
//
// After a rewrite the history has new commit ids, so a push has to be forced
// and everyone else has to re-clone. A backup is taken first, and --write
// refuses without one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  valuesToRedact,
  replacementsFile,
  redactText,
  chooseFiles,
  REDACTED,
} from './evisa-redact.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);

/** The flags that stand alone, as against the ones that take a value. */
const ALONE = new Set(['write', 'force', 'push']);

/** The arguments, as a name to value map. */
function readArguments(argv) {
  const given = { repo: path.join(HERE, '..') };
  for (let at = 0; at < argv.length; at += 1) {
    const name = argv[at].replace(/^--/, '');
    if (ALONE.has(name)) {
      given[name] = true;
    } else if (argv[at].startsWith('--')) {
      given[name] = argv[at + 1];
      at += 1;
    }
  }
  return given;
}

/**
 * The configuration, read from JSON beside the values it names.
 *
 * Paths inside it are read relative to the config itself, so the whole of a
 * run lives in one directory outside the repository and moves with it.
 */
function readConfig(file) {
  const beside = path.dirname(path.resolve(file));
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const near = (one) => (path.isAbsolute(one) ? one : path.join(beside, one));
  return {
    values: config.values ?? [],
    valuesFiles: [config.valuesFile, ...(config.valuesFiles ?? [])]
      .filter(Boolean)
      .map(near),
    // A passport is a path, or a path with the fields to leave out of it.
    passports: (config.passports ?? []).map((one) =>
      typeof one === 'string'
        ? { file: near(one), skip: [] }
        : { file: near(one.file), skip: one.skip ?? [] }
    ),
    only: config.only ?? [],
    except: config.except ?? [],
    keep: config.keep ?? [],
  };
}

/**
 * Checks that nothing named as kept is about to be redacted.
 *
 * A spelling rule reaches further than the value it was given: asked to
 * redact a surname it also takes the upper-case form, and a nickname that
 * contains it would go with it. What must survive is named, and what is
 * named gets checked.
 */
export function keptValuesAreSafe(wanted, keep) {
  const broken = [];
  for (const kept of keep) {
    const { removed } = redactText(kept, wanted);
    if (removed) {
      broken.push(kept);
    }
  }
  return broken;
}

/** Runs git in the repository, and gives back what it said. */
function git(repo, args, { quiet = false } = {}) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 256,
      stdio: quiet ? ['ignore', 'pipe', 'ignore'] : undefined,
    }).trim();
  } catch (error) {
    // Several git commands exit 1 to mean "nothing found", which is an
    // answer, not a failure.
    if (error.status === 1) {
      return (error.stdout ?? '').trim();
    }
    throw error;
  }
}

/** Reads a passport the way the bot does, for the values it holds. */
async function readThePassport(image) {
  const { readPassportMrz, readPassportPage } =
    await import('./evisa-passport.mjs');
  const mrz = await readPassportMrz(image);
  const page = await readPassportPage(image, mrz.data ?? {});
  return { ...(mrz.data ?? {}), ...(page.data ?? {}) };
}

/** Values listed in a file, one a line, comments and blanks ignored. */
function readValuesFile(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/**
 * Every commit that holds one of the values, and the files that hold it.
 *
 * The search is of what each commit's tree actually contains, commit by
 * commit. A diff search is the wrong question here: it matches a commit for
 * removing a value as readily as for adding one, so a finished rewrite
 * reports every commit it just mended as still holding what it took out.
 *
 * The refs filter-branch leaves behind under refs/original are the history
 * as it was, kept so a rewrite can be undone. They are not searched: they
 * are the backup, and they go when the rewrite is accepted.
 */
function commitsHolding(repo, values, chosen = () => true) {
  const found = new Map();
  const commits = git(repo, ['rev-list', '--branches', '--remotes'])
    .split('\n')
    .filter(Boolean);
  const pattern = values
    .map((value) => value.replace(/[.[\]*+?^${}()|\\]/g, '\\$&'))
    .join('|');
  for (const commit of commits) {
    const said = git(repo, ['grep', '-lIE', pattern, commit], { quiet: true });
    // Only the files a run is allowed to change. A value left standing in a
    // file the config excludes is a decision somebody made, and reporting it
    // as an outstanding leak buries the ones that are not.
    const files = said
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(line.indexOf(':') + 1))
      .filter(chosen);
    if (files.length) {
      found.set(commit.slice(0, 7), new Set(files));
    }
  }
  return found;
}

/**
 * What the checked-out tree still holds, value by value.
 *
 * The history search answers what was published; this answers what is about
 * to be. The difference matters, because a rewrite turns a value into
 * [REDACTED] wherever it stands, including in a fixture the tests read, and
 * a test asserting on [REDACTED] is a test that has stopped saying anything.
 *
 * So these are named before a run, not after it: whoever decides what counts
 * as personal data also gets to replace it with something of the same shape
 * that belongs to nobody, and the rewrite then finds the tree already clean.
 */
export function treeHolding(repo, values, chosen = () => true) {
  const found = new Map();
  const files = git(repo, ['ls-files']).split('\n').filter(Boolean);
  for (const file of files.filter(chosen)) {
    const full = path.join(repo, file);
    if (!fs.existsSync(full)) {
      continue;
    }
    const text = fs.readFileSync(full, 'utf8').toLowerCase();
    const hits = values.filter((value) => text.includes(value.toLowerCase()));
    if (hits.length) {
      found.set(file, hits);
    }
  }
  return found;
}

/**
 * Every value the config asks for, longest first.
 *
 * A passport may be listed with fields to leave out of the reading. One
 * person's name can be public while their passport number and dates are
 * not, and the whole reading is otherwise all or nothing.
 */
async function valuesWanted(config) {
  const values = [...valuesToRedact({}, config.values)];
  for (const passport of config.passports) {
    const { file, skip: leaveOut = [] } = passport;
    const skip = new Set(leaveOut);
    console.log(`Reading ${file} …`);
    const reading = await readThePassport(file);
    for (const field of skip) {
      delete reading[field];
    }
    const named = Object.keys(reading).filter((key) => reading[key]);
    console.log(
      `  read: ${named.join(', ') || 'nothing'}` +
        `${skip.size ? `; left out: ${[...skip].join(', ')}` : ''}`
    );
    values.push(...valuesToRedact(reading));
  }
  for (const file of config.valuesFiles) {
    values.push(...valuesToRedact({}, readValuesFile(file)));
  }
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/** Says what the checked-out tree still holds, and why that wants a hand. */
function reportTheTree(repo, wanted, chosen) {
  const inTree = treeHolding(repo, wanted, chosen);
  if (!inTree.size) {
    return;
  }
  console.log(
    `\n${inTree.size} files in the working tree still hold a value.\n` +
      'A rewrite replaces it there too, so a test reading one as a fixture\n' +
      'would then be asserting on [REDACTED]. Replace these by hand first,\n' +
      'with values of the same shape that belong to nobody:'
  );
  for (const [file, hits] of [...inTree].sort()) {
    console.log(`  ${file}`);
    for (const hit of hits) {
      console.log(`      ${hit}`);
    }
  }
  console.log('');
}

/** Takes the mirror backup a rewrite is undone from. */
function takeBackup(repo) {
  const beside = `${repo.replace(/\/$/, '')}-backup`;
  const mirror = path.join(beside, 'repo.git');
  if (fs.existsSync(mirror)) {
    console.log(`Refreshing the backup at ${mirror} …`);
    execFileSync('git', ['-C', mirror, 'fetch', '--all', '--prune'], {
      stdio: 'ignore',
    });
    return mirror;
  }
  console.log(`Taking a backup at ${mirror} …`);
  fs.mkdirSync(beside, { recursive: true });
  execFileSync('git', ['clone', '--mirror', repo, mirror], { stdio: 'ignore' });
  return mirror;
}

/**
 * Whether the repository still works: its own tests, run as they are run.
 *
 * A rewrite that takes a value out of a fixture the tests read leaves a
 * broken repository, and the moment to discover that is before the push.
 */
function testsStillPass(repo) {
  try {
    execFileSync('npm', ['test'], { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Force-pushes every branch, which is what publishes the redaction. */
function pushEverything(repo) {
  const branches = git(repo, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
  ])
    .split('\n')
    .filter(Boolean);
  console.log(`\nForce-pushing ${branches.length} branches …`);
  execFileSync(
    'git',
    [
      '-C',
      repo,
      'push',
      '--force',
      'origin',
      ...branches.map((b) => `${b}:${b}`),
    ],
    { stdio: 'inherit' }
  );
}

/** The config a run works from, with anything named on the line folded in. */
function configFor(given) {
  const config = given.config
    ? readConfig(given.config)
    : {
        values: [],
        valuesFiles: [],
        passports: [],
        only: [],
        except: [],
        keep: [],
      };
  if (given.passport) {
    config.passports.push({ file: given.passport, skip: [] });
  }
  if (given.values) {
    config.valuesFiles.push(given.values);
  }
  return config;
}

async function main() {
  const given = readArguments(process.argv.slice(2));
  const repo = path.resolve(given.repo);
  const config = configFor(given);

  const wanted = await valuesWanted(config);
  if (!wanted.length) {
    console.error(
      'Nothing to redact. Give --config <file>, --passport <image> or ' +
        '--values <file>.'
    );
    process.exit(1);
  }
  // The values are what must not be published, so the count is printed and
  // the values themselves never are.
  console.log(`${wanted.length} values to look for.`);

  // What must survive is checked before anything is searched for, since a
  // spelling rule reaches further than the value it was given.
  const broken = keptValuesAreSafe(wanted, config.keep);
  if (broken.length) {
    console.error(
      `\nThese are named as kept but would be redacted:\n${broken
        .map((one) => `  ${one}`)
        .join('\n')}\nNarrow the values, or take them out of "keep".`
    );
    process.exit(1);
  }
  if (config.keep.length) {
    console.log(`${config.keep.length} values are named as kept, and survive.`);
  }

  const chosen = chooseFiles(config);
  if (config.only.length || config.except.length) {
    console.log(
      `Files: ${config.only.length ? config.only.join(', ') : 'all'}` +
        `${config.except.length ? `, except ${config.except.join(', ')}` : ''}`
    );
  }

  reportTheTree(repo, wanted, chosen);

  const holding = commitsHolding(repo, wanted, chosen);
  if (!holding.size) {
    console.log('No commit holds any of them. Nothing to do.');
    return;
  }
  console.log(`${holding.size} commits hold at least one.`);
  // The files are what a person needs to see to judge a run: a trace nobody
  // meant to commit is one thing, a fixture the tests read is another.
  const inFiles = new Set();
  for (const [, files] of holding) {
    for (const file of files) {
      inFiles.add(file);
    }
  }
  console.log(`${inFiles.size} files across those commits:`);
  for (const file of [...inFiles].sort()) {
    console.log(`  ${file}`);
  }

  if (!given.write) {
    console.log(
      '\nThis was a dry run and nothing was changed.\n' +
        'Re-run with --write to rewrite the history.'
    );
    return;
  }

  rewriteAndPublish(repo, { wanted, config, chosen, given });
}

/**
 * Rewrites, proves the result, and publishes it.
 *
 * Nothing is pushed on a promise. The history is searched again with the
 * same question the dry run asked, the repository is tested as it is
 * normally tested, and only a run that passes both reaches the remote.
 */
function rewriteAndPublish(repo, { wanted, config, chosen, given }) {
  if (git(repo, ['status', '--porcelain'])) {
    console.error(
      '\nThe working tree has changes. Commit or stash them first: a rewrite ' +
        'refuses to run over them, and they would not be redacted anyway.'
    );
    process.exit(1);
  }

  if (!given.force) {
    takeBackup(repo);
  }

  console.log('\nRewriting. Every commit keeps its place; only values change.');
  rewrite(repo, wanted, config);

  const left = commitsHolding(repo, wanted, chosen);
  if (left.size) {
    console.error(
      `\nStill found in ${left.size} commits:\n${[...left]
        .flatMap(([id, files]) => [...files].map((f) => `  ${id} ${f}`))
        .join('\n')}\nNothing was pushed.`
    );
    process.exit(1);
  }
  console.log('\nNo commit holds any of the values now.');

  console.log('Running the tests against the rewritten tree …');
  if (!testsStillPass(repo)) {
    console.error(
      'The tests fail after the rewrite, so a value the code needed went ' +
        'with the ones that had to go.\n' +
        `Nothing was pushed. Undo with the backup at ${repo}-backup/repo.git, ` +
        'or with refs/original in this repository.'
    );
    process.exit(1);
  }
  console.log('The tests pass.');

  if (!given.push) {
    console.log(
      '\nThe commit ids are new, so the push has to be forced. Re-run with ' +
        '--push, or:\n  git push --force origin --all\n' +
        'Everyone else has to re-clone.'
    );
    return;
  }
  pushEverything(repo);
  console.log('\nDone. Everyone else has to re-clone.');
}

/** Whether git-filter-repo is installed and can be used. */
function hasFilterRepo(repo) {
  try {
    execFileSync('git', ['-C', repo, 'filter-repo', '--version'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Replaces the values with git-filter-repo, which does this natively.
 *
 * It is given the replacements in a file, so no value reaches a command
 * line where a process list would show it. `--partial` keeps the remotes,
 * since this mends a repository that goes on being used.
 */
function rewriteWithFilterRepo(repo, values) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-'));
  const listFile = path.join(dir, 'replacements.txt');
  fs.writeFileSync(listFile, replacementsFile(values), { mode: 0o600 });
  try {
    execFileSync(
      'git',
      ['-C', repo, 'filter-repo', '--replace-text', listFile, '--partial'],
      { stdio: 'inherit' }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Replaces the values in every blob of every commit.
 *
 * git's own filter-branch is the fallback, since it ships with git and needs
 * nothing installed to mend a leak. The tree filter reads each file, replaces
 * what it finds and writes it back, so files and commits are all kept and
 * only their contents change.
 */
function rewriteWithFilterBranch(repo, values, config = {}) {
  const script = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'redact-run-')),
    'redact-tree.mjs'
  );
  // The filter runs as its own process per commit, so it is given the
  // values in a file beside it, not on a command line where they would
  // show up in a process list.
  const valuesFile = `${script}.values.json`;
  fs.writeFileSync(
    valuesFile,
    JSON.stringify({
      values,
      only: config.only ?? [],
      except: config.except ?? [],
    }),
    { mode: 0o600 }
  );
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
import path from 'node:path';
import { redactText, chooseFiles } from ${JSON.stringify(path.join(HERE, 'evisa-redact.mjs'))};
const held = JSON.parse(fs.readFileSync(${JSON.stringify(valuesFile)}, 'utf8'));
const chosen = chooseFiles(held);
const root = process.cwd();
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') { continue; }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    // Chosen by the path as the repository writes it, which is what the
    // globs in the config are written against.
    if (!entry.isFile() || !chosen(path.relative(root, full))) { continue; }
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const done = redactText(text, held.values);
    if (done.removed) { fs.writeFileSync(full, done.text); }
  }
};
walk(root);
`,
    { mode: 0o700 }
  );
  execFileSync(
    'git',
    [
      '-C',
      repo,
      'filter-branch',
      '--force',
      '--tree-filter',
      `node ${JSON.stringify(script)}`,
      '--tag-name-filter',
      'cat',
      '--',
      '--all',
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: '1' },
    }
  );
  fs.rmSync(path.dirname(script), { recursive: true, force: true });
}

/**
 * Rewrites with whichever tool suits the run.
 *
 * git-filter-repo is faster and replaces text natively, but it replaces it
 * in every file it sees. A run that names files needs the tree filter, which
 * reads each path and decides.
 */
function rewrite(repo, values, config = {}) {
  const byFile = (config.only ?? []).length || (config.except ?? []).length;
  if (!byFile && hasFilterRepo(repo)) {
    console.log('Using git-filter-repo.');
    rewriteWithFilterRepo(repo, values);
    return;
  }
  console.log(
    byFile
      ? 'Choosing files, so using filter-branch.'
      : 'git-filter-repo is not installed; using filter-branch.'
  );
  rewriteWithFilterBranch(repo, values, config);
}

/** Redacting a single file, for a caller that wants one without the history. */
export { redactText, REDACTED };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
