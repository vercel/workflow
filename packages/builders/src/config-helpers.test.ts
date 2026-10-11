import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { findTsConfigPath, resolveProjectRoot } from './config-helpers.js';

describe('findTsConfigPath', () => {
  it('resolves the nearest tsconfig in parent directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-tsconfig-root-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));

    const appRoot = join(root, 'apps', 'web');
    mkdirSync(appRoot, { recursive: true });

    const configPath = join(root, 'tsconfig.json');
    writeFileSync(configPath, '{"compilerOptions":{"strict":true}}\n');

    await expect(findTsConfigPath(appRoot)).resolves.toBe(configPath);
  });

  it('falls back to jsconfig when no tsconfig exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-jsconfig-root-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));

    const appRoot = join(root, 'apps', 'web');
    mkdirSync(appRoot, { recursive: true });

    const configPath = join(root, 'jsconfig.json');
    writeFileSync(configPath, '{"compilerOptions":{"checkJs":true}}\n');

    await expect(findTsConfigPath(appRoot)).resolves.toBe(configPath);
  });
});

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
