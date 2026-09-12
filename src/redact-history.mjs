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
// Usage:
//   node src/redact-history.mjs --passport <image>        what would change
//   node src/redact-history.mjs --values <file>           one value a line
//   node src/redact-history.mjs --values <file> --write   rewrite history
//
//   --repo <path>    which repository, default the one this lives in
//   --passport <img> a passport page, read for the values it holds
//   --values <file>  more values, one a line, kept outside the repository
//   --write          rewrite; without it nothing is changed
//
// After a rewrite the history has new commit ids, so a push has to be
// forced and everyone else has to re-clone. Take a backup first: this
// refuses to run without one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  valuesToRedact,
  replacementsFile,
  redactText,
  REDACTED,
} from './evisa-redact.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);

/** The arguments, as a name to value map. */
function readArguments(argv) {
  const given = { repo: path.join(HERE, '..') };
  for (let at = 0; at < argv.length; at += 1) {
    const name = argv[at].replace(/^--/, '');
    if (name === 'write' || name === 'force') {
      given[name] = true;
    } else if (argv[at].startsWith('--')) {
      given[name] = argv[at + 1];
      at += 1;
    }
  }
  return given;
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
 * Every commit whose content holds one of the values.
 *
 * Asked of git itself, so it covers every branch and every blob, not just
 * what the working tree has now.
 */
function commitsHolding(repo, values) {
  const pattern = values.map((v) => v.replace(/[.[\]*+?^${}()|\\]/g, '\\$&'));
  const found = new Map();
  for (const value of pattern) {
    const said = git(repo, ['log', '--all', '--oneline', `-G${value}`]);
    for (const line of said.split('\n').filter(Boolean)) {
      const id = line.split(' ')[0];
      found.set(id, (found.get(id) ?? new Set()).add(value));
    }
  }
  return found;
}

/** Whether a backup of this repository exists beside it. */
function hasBackup(repo) {
  const beside = `${repo.replace(/\/$/, '')}-backup`;
  return fs.existsSync(path.join(beside, 'repo.git'));
}

async function main() {
  const given = readArguments(process.argv.slice(2));
  const repo = path.resolve(given.repo);

  const values = [];
  if (given.passport) {
    console.log(`Reading ${given.passport} …`);
    const reading = await readThePassport(given.passport);
    const named = Object.keys(reading).filter((key) => reading[key]);
    console.log(`  read: ${named.join(', ') || 'nothing'}`);
    values.push(...valuesToRedact(reading));
  }
  if (given.values) {
    values.push(...valuesToRedact({}, readValuesFile(given.values)));
  }
  const wanted = [...new Set(values)].sort((a, b) => b.length - a.length);

  if (!wanted.length) {
    console.error(
      'Nothing to redact. Give --passport <image> or --values <file>.'
    );
    process.exit(1);
  }
  // The values are what must not be published, so the count is printed and
  // the values themselves never are.
  console.log(`${wanted.length} values to look for.`);

  const holding = commitsHolding(repo, wanted);
  if (!holding.size) {
    console.log('No commit holds any of them. Nothing to do.');
    return;
  }
  console.log(`${holding.size} commits hold at least one:`);
  for (const [id] of holding) {
    const subject = git(repo, ['log', '-1', '--format=%s', id]);
    console.log(`  ${id} ${subject}`);
  }

  if (!given.write) {
    console.log(
      '\nThis was a dry run and nothing was changed.\n' +
        'Re-run with --write to rewrite the history.'
    );
    return;
  }

  if (!hasBackup(repo) && !given.force) {
    console.error(
      `\nNo backup found at ${repo}-backup/repo.git.\n` +
        'Make one first:\n' +
        `  git clone --mirror ${repo} ${repo}-backup/repo.git\n` +
        'Or pass --force if you are sure.'
    );
    process.exit(1);
  }

  console.log('\nRewriting. Every commit keeps its place; only values change.');
  rewrite(repo, wanted);

  const left = commitsHolding(repo, wanted);
  console.log(
    left.size
      ? `\nStill found in ${left.size} commits. Look at those by hand.`
      : '\nDone. No commit holds any of the values now.'
  );
  console.log(
    'The commit ids are new, so the push has to be forced:\n' +
      '  git push --force-with-lease --all\n' +
      'Everyone else has to re-clone.'
  );
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
function rewriteWithFilterBranch(repo, values) {
  const script = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'redact-run-')),
    'redact-tree.mjs'
  );
  // The filter runs as its own process per commit, so it is given the
  // values in a file beside it, not on a command line where they would
  // show up in a process list.
  const valuesFile = `${script}.values.json`;
  fs.writeFileSync(valuesFile, JSON.stringify(values), { mode: 0o600 });
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
import path from 'node:path';
import { redactText, worthSearching } from ${JSON.stringify(path.join(HERE, 'evisa-redact.mjs'))};
const values = JSON.parse(fs.readFileSync(${JSON.stringify(valuesFile)}, 'utf8'));
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') { continue; }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.isFile() || !worthSearching(full)) { continue; }
    let held;
    try { held = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const { text, removed } = redactText(held, values);
    if (removed) { fs.writeFileSync(full, text); }
  }
};
walk(process.cwd());
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

/** Rewrites with whichever tool this machine has. */
function rewrite(repo, values) {
  if (hasFilterRepo(repo)) {
    console.log('Using git-filter-repo.');
    rewriteWithFilterRepo(repo, values);
    return;
  }
  console.log('git-filter-repo is not installed; using filter-branch.');
  rewriteWithFilterBranch(repo, values);
}

/** Redacting a single file, for a caller that wants one without the history. */
export { redactText, REDACTED };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
