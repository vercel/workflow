import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SvelteKitBuilder } from './builder.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-sveltekit-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SvelteKitBuilder config', () => {
  it('derives project root from the nearest workspace root', () => {
    const repoRoot = createTempDir();
    const appRoot = join(repoRoot, 'apps/web');
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');

    const builder = new SvelteKitBuilder({ workingDir: appRoot }) as any;

    expect(builder.config).toMatchObject({
      workingDir: appRoot,
      projectRoot: repoRoot,
      dirs: ['workflows', 'src/workflows', 'routes', 'src/routes'],
    });
  });
});
