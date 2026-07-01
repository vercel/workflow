import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { LocalBuilder, VercelBuilder } from './builder.js';

describe('LocalBuilder config', () => {
  it('passes Astro dirs and workspace root to the workflow builder', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'workflow-astro-config-'));
    onTestFinished(() => rmSync(repoRoot, { recursive: true, force: true }));

    const appRoot = join(repoRoot, 'apps/web');
    mkdirSync(join(appRoot, 'source'), { recursive: true });
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');

    const builder = new LocalBuilder({
      workingDir: appRoot,
      dirs: [join(appRoot, 'source/pages'), join(appRoot, 'source/workflows')],
    }) as any;

    expect(builder.config).toMatchObject({
      workingDir: appRoot,
      dirs: [join(appRoot, 'source/pages'), join(appRoot, 'source/workflows')],
      projectRoot: repoRoot,
      moduleSpecifierRoot: appRoot,
    });
  });

  it('passes explicit workflow builder options through', () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'workflow-astro-options-'));
    onTestFinished(() => rmSync(appRoot, { recursive: true, force: true }));

    const projectRoot = join(appRoot, '../repo');
    const moduleSpecifierRoot = join(appRoot, 'module-root');
    const dirs = ['custom/pages', 'custom/workflows'];
    const builder = new LocalBuilder({
      workingDir: appRoot,
      dirs,
      projectRoot,
      moduleSpecifierRoot,
      sourcemap: false,
    }) as any;

    expect(builder.config).toMatchObject({
      workingDir: appRoot,
      dirs,
      projectRoot,
      moduleSpecifierRoot,
      sourcemap: false,
    });
  });

  it('passes Vercel runtime options through', () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'workflow-astro-vercel-'));
    onTestFinished(() => rmSync(appRoot, { recursive: true, force: true }));

    const builder = new VercelBuilder({
      workingDir: appRoot,
      runtime: 'nodejs22.x',
    }) as any;

    expect(builder.config).toMatchObject({
      workingDir: appRoot,
      runtime: 'nodejs22.x',
    });
  });
});
