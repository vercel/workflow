import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCurrentGitBranch } from './git-branch.js';

describe('getCurrentGitBranch', () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-git-branch-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the checked-out branch', async () => {
    git('init', '-q', '-b', 'feat/a');
    git(
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init'
    );
    expect(await getCurrentGitBranch(dir)).toBe('feat/a');
  });

  it('returns undefined on a detached HEAD', async () => {
    git('init', '-q', '-b', 'main');
    git(
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init'
    );
    git('checkout', '-q', '--detach');
    expect(await getCurrentGitBranch(dir)).toBeUndefined();
  });

  it('returns undefined outside a git repository', async () => {
    expect(await getCurrentGitBranch(dir)).toBeUndefined();
  });
});
