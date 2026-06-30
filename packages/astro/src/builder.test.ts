import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalBuilder, resolveAstroBuilderConfig } from './builder.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-astro-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveAstroBuilderConfig', () => {
  it('derives source dirs and project root from Astro config paths', () => {
    const repoRoot = createTempDir();
    const appRoot = join(repoRoot, 'apps/web');
    const srcDir = join(appRoot, 'source');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');

    expect(
      resolveAstroBuilderConfig({
        workingDir: appRoot,
        srcDir,
      })
    ).toEqual({
      workingDir: appRoot,
      srcDir,
      pagesDir: join(srcDir, 'pages'),
      dirs: ['source/pages', 'source/workflows'],
      projectRoot: repoRoot,
    });
  });

  it('lets explicit projectRoot win over workspace discovery', () => {
    const repoRoot = createTempDir();
    const appRoot = join(repoRoot, 'apps/web');
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');

    expect(
      resolveAstroBuilderConfig({
        workingDir: appRoot,
        projectRoot: '/manual/root',
      }).projectRoot
    ).toBe('/manual/root');
  });

  it('passes derived config to the local workflow builder', () => {
    const repoRoot = createTempDir();
    const appRoot = join(repoRoot, 'apps/web');
    mkdirSync(join(appRoot, 'source'), { recursive: true });
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');

    const builder = new LocalBuilder({
      workingDir: appRoot,
      srcDir: 'source',
    }) as any;

    expect(builder.config).toMatchObject({
      workingDir: appRoot,
      dirs: ['source/pages', 'source/workflows'],
      projectRoot: repoRoot,
    });
  });
});
