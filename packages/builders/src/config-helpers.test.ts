import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { resolveProjectRoot } from './config-helpers.js';

describe('resolveProjectRoot', () => {
  it('prefers the workspace root over app lockfiles', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'workflow-project-root-'));
    onTestFinished(() => rmSync(repoRoot, { recursive: true, force: true }));

    const appRoot = join(repoRoot, 'apps/web');
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(join(appRoot, 'package-lock.json'), '{}\n');

    expect(resolveProjectRoot(appRoot)).toBe(repoRoot);
  });
});
