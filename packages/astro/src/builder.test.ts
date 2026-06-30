import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalBuilder } from './builder.js';

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

describe('LocalBuilder config', () => {
  it('passes Astro dirs and workspace root to the workflow builder', () => {
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
      dirs: [join(appRoot, 'source/pages'), join(appRoot, 'source/workflows')],
      projectRoot: repoRoot,
    });
  });
});
