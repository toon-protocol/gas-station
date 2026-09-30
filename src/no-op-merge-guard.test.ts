/**
 * The no-op merge guard (.github/scripts/no-op-merge-guard.sh) has to fail a PR
 * whose merge result changes nothing and pass one with a real diff. These
 * tests build throwaway repos with a real merge commit shaped like
 * refs/pull/N/merge and run the script against them. No network, no chain.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(
  new URL('../.github/scripts/no-op-merge-guard.sh', import.meta.url),
);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();
}

/**
 * Base tip `main` and a PR branch; HEAD ends as a merge of the two (base
 * first, head second), like refs/pull/N/merge. `landOnBase` makes main acquire
 * the PR's exact change first, which is the connector#1008 shape.
 */
function mergeRef(opts: { prChangesFile: boolean; landOnBase: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'noop-guard-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'pr');
  if (opts.prChangesFile) {
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'commit', '-q', '-am', 'pr change');
  } else {
    // A change and its revert: commits that cancel out.
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'commit', '-q', '-am', 'pr change');
    git(dir, 'revert', '--no-edit', 'HEAD');
  }
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  if (opts.landOnBase) {
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'commit', '-q', '-am', 'same change from another PR');
  }
  git(dir, 'checkout', '-q', '--detach', 'main');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'pr');
  return { dir, head };
}

function run(
  dir: string,
  head: string,
  changedFiles: string,
  event = 'pull_request',
) {
  return spawnSync('bash', [script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      GITHUB_EVENT_NAME: event,
      PR_HEAD_SHA: head,
      PR_BASE_REF: 'main',
      PR_NUMBER: '1',
      PR_CHANGED_FILES: changedFiles,
    },
  });
}

describe('no-op merge guard', () => {
  it('passes a PR with a real diff', () => {
    const { dir, head } = mergeRef({ prChangesFile: true, landOnBase: false });
    const r = run(dir, head, '1');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('changes 1 file(s)');
  });

  it('fails a PR whose content is already on the base branch', () => {
    const { dir, head } = mergeRef({ prChangesFile: true, landOnBase: true });
    const r = run(dir, head, '1');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('already on main');
  });

  it('fails a PR whose own commits change nothing', () => {
    const { dir, head } = mergeRef({ prChangesFile: false, landOnBase: false });
    const r = run(dir, head, '0');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('cancel out');
  });

  it('passes plainly on a push event', () => {
    const { dir, head } = mergeRef({ prChangesFile: false, landOnBase: false });
    expect(run(dir, head, '0', 'push').status).toBe(0);
  });

  it('warns and passes when HEAD is not a merge commit', () => {
    const { dir, head } = mergeRef({ prChangesFile: true, landOnBase: false });
    git(dir, 'checkout', '-q', '--detach', head);
    const r = run(dir, head, '1');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::warning::');
  });
});
