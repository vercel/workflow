import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createWatchIgnorePredicate,
  parseIgnoredPathsEnv,
} from './watch-ignore.js';

const toPosix = (pathname: string) => pathname.replace(/\\/g, '/');

describe('parseIgnoredPathsEnv', () => {
  test('returns empty for undefined/empty', () => {
    expect(parseIgnoredPathsEnv(undefined)).toEqual([]);
    expect(parseIgnoredPathsEnv('')).toEqual([]);
    expect(parseIgnoredPathsEnv('  , ,')).toEqual([]);
  });

  test('splits, trims, drops empties, and normalizes slashes', () => {
    expect(parseIgnoredPathsEnv('/huge/, /vendor/ ,,')).toEqual([
      '/huge/',
      '/vendor/',
    ]);
    expect(parseIgnoredPathsEnv('\\a\\b\\')).toEqual(['/a/b/']);
  });
});

describe('createWatchIgnorePredicate', () => {
  let root: string;

  const p = (...segments: string[]) => toPosix(join(root, ...segments));

  const write = (relPath: string, content: string) => {
    const abs = join(root, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeEach(() => {
    root = toPosix(mkdtempSync(join(tmpdir(), 'wf-watch-ignore-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('ignores gitignored directory subtree, keeps siblings', () => {
    write('.gitignore', 'ignored-tree/\n');
    const isIgnored = createWatchIgnorePredicate({ workingDir: root });

    expect(isIgnored(p('ignored-tree'))).toBe(true);
    expect(isIgnored(p('ignored-tree/deep/nested/file.ts'))).toBe(true);
    expect(isIgnored(p('src/workflows/a.ts'))).toBe(false);
  });

  test('honors gitignore negation (file-level re-include)', () => {
    write('.gitignore', '*.log\n!keep.log\n');
    const isIgnored = createWatchIgnorePredicate({ workingDir: root });

    expect(isIgnored(p('debug.log'))).toBe(true);
    expect(isIgnored(p('keep.log'))).toBe(false);
  });

  test('cannot re-include a file under an excluded directory (git semantics)', () => {
    write('.gitignore', 'generated/\n!generated/keep.ts\n');
    const isIgnored = createWatchIgnorePredicate({ workingDir: root });

    // Git cannot re-include a path when a parent directory is excluded, so
    // the negation is inert and both paths stay ignored.
    expect(isIgnored(p('generated/skip.ts'))).toBe(true);
    expect(isIgnored(p('generated/keep.ts'))).toBe(true);
  });

  test('honors nested gitignore files up to projectRoot', () => {
    // root/.gitignore ignores a workspace-level tree;
    // root/app/.gitignore ignores an app-level tree.
    write('.gitignore', 'workspace-junk/\n');
    write('app/.gitignore', 'app-junk/\n');

    const workingDir = p('app');
    const isIgnored = createWatchIgnorePredicate({
      workingDir,
      projectRoot: root,
    });

    expect(isIgnored(p('workspace-junk/x.ts'))).toBe(true);
    expect(isIgnored(p('app/app-junk/y.ts'))).toBe(true);
    expect(isIgnored(p('app/src/keep.ts'))).toBe(false);
  });

  test('built-in fragments are ignored without any .gitignore', () => {
    const isIgnored = createWatchIgnorePredicate({ workingDir: root });

    expect(isIgnored(p('node_modules/pkg/index.js'))).toBe(true);
    expect(isIgnored(p('.next/server/x.js'))).toBe(true);
    expect(isIgnored(p('.git/HEAD'))).toBe(true);
    expect(isIgnored(p('src/workflows/a.ts'))).toBe(false);
  });

  test('WORKFLOW_DEV_WATCH_IGNORED_PATHS fragments are honored', () => {
    const isIgnored = createWatchIgnorePredicate({
      workingDir: root,
      envIgnoredPaths: '/huge/, /vendor/',
    });

    expect(isIgnored(p('huge/data/x.ts'))).toBe(true);
    expect(isIgnored(p('vendor/lib/y.ts'))).toBe(true);
    expect(isIgnored(p('app/z.ts'))).toBe(false);
  });

  test('extraFragments (e.g. generated dir) are ignored', () => {
    const generatedDir = p('.next/workflow-generated');
    const isIgnored = createWatchIgnorePredicate({
      workingDir: root,
      extraFragments: [generatedDir],
    });

    expect(isIgnored(`${generatedDir}/flow/route.js`)).toBe(true);
  });

  test('paths outside the gitignore dir are unaffected', () => {
    write('.gitignore', 'secret/\n');
    const isIgnored = createWatchIgnorePredicate({ workingDir: root });

    // A sibling of `root` named to include "secret" must not be pruned by a
    // relative-path collision.
    expect(isIgnored(toPosix(join(root, '..', 'secret-sibling', 'a.ts')))).toBe(
      false
    );
  });
});
