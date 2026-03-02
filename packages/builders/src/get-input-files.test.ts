import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseBuilder } from './base-builder.js';
import type { StandaloneConfig } from './types.js';

/**
 * Minimal subclass to expose the protected `getInputFiles()` for testing.
 */
class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {
    // no-op
  }

  // Expose for tests
  public getInputFiles(): Promise<string[]> {
    return super.getInputFiles();
  }
}

// Resolve symlinks in tmpdir to avoid macOS /var -> /private/var issues
const realTmpdir = realpathSync(tmpdir());

/**
 * Normalize a path to forward slashes for cross-platform comparison.
 * tinyglobby always returns forward-slash paths, even on Windows,
 * while Node's `path.join()` uses backslashes on Windows.
 */
function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

function writeFile(dir: string, relativePath: string, content = ''): string {
  const fullPath = join(dir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

function createBuilder(workingDir: string, dirs: string[]): TestBuilder {
  const config: StandaloneConfig = {
    buildTarget: 'standalone',
    workingDir,
    dirs,
    stepsBundlePath: join(workingDir, 'steps.js'),
    workflowsBundlePath: join(workingDir, 'workflows.js'),
    webhookBundlePath: join(workingDir, 'webhook.js'),
  };
  return new TestBuilder(config);
}

describe('getInputFiles', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'get-input-files-'));
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('discovers files inside dot-prefixed directories', async () => {
    const srcDir = join(testRoot, 'src');
    writeFile(srcDir, '.hidden/step.ts', "'use step';");
    writeFile(srcDir, '.config/workflow.ts', "'use workflow';");
    writeFile(srcDir, 'regular/step.ts', "'use step';");

    const builder = createBuilder(testRoot, ['src']);
    const files = (await builder.getInputFiles()).map(normalize);

    expect(files).toContain(normalize(join(srcDir, '.hidden/step.ts')));
    expect(files).toContain(normalize(join(srcDir, '.config/workflow.ts')));
    expect(files).toContain(normalize(join(srcDir, 'regular/step.ts')));
  });

  it('discovers dot-prefixed files', async () => {
    const srcDir = join(testRoot, 'src');
    writeFile(srcDir, '.hidden-step.ts', "'use step';");
    writeFile(srcDir, 'visible-step.ts', "'use step';");

    const builder = createBuilder(testRoot, ['src']);
    const files = (await builder.getInputFiles()).map(normalize);

    expect(files).toContain(normalize(join(srcDir, '.hidden-step.ts')));
    expect(files).toContain(normalize(join(srcDir, 'visible-step.ts')));
  });

  it('still excludes explicitly ignored dot-directories', async () => {
    const srcDir = join(testRoot, 'src');
    writeFile(srcDir, '.git/hooks/pre-commit.ts');
    writeFile(srcDir, '.next/server/page.ts');
    writeFile(srcDir, '.nuxt/workflow/steps.mjs');
    writeFile(srcDir, '.vercel/output/step.ts');
    writeFile(srcDir, '.svelte-kit/output/step.ts');
    writeFile(srcDir, '.workflow-data/state.ts');
    writeFile(srcDir, '.well-known/workflow/route.ts');
    writeFile(srcDir, '.turbo/cache/build.ts');
    writeFile(srcDir, '.cache/babel/plugin.js');
    writeFile(srcDir, '.yarn/releases/yarn.cjs');
    writeFile(srcDir, '.pnpm-store/v3/files.ts');
    writeFile(srcDir, 'node_modules/pkg/index.ts');
    // This one should still be found
    writeFile(srcDir, '.custom/step.ts', "'use step';");

    const builder = createBuilder(testRoot, ['src']);
    const files = (await builder.getInputFiles()).map(normalize);

    expect(files).not.toContain(
      normalize(join(srcDir, '.git/hooks/pre-commit.ts'))
    );
    expect(files).not.toContain(
      normalize(join(srcDir, '.next/server/page.ts'))
    );
    expect(files).not.toContain(
      normalize(join(srcDir, '.nuxt/workflow/steps.mjs'))
    );
    expect(files).not.toContain(
      normalize(join(srcDir, '.vercel/output/step.ts'))
    );
    expect(files).not.toContain(
      normalize(join(srcDir, '.svelte-kit/output/step.ts'))
    );
    expect(files).not.toContain(
      normalize(join(srcDir, '.workflow-data/state.ts'))
    );
    expect(files).not.toContain(
      normalize(join(srcDir, '.well-known/workflow/route.ts'))
    );
    expect(files).not.toContain(
      normalize(join(srcDir, '.turbo/cache/build.ts'))
    );
    expect(files).not.toContain(
      normalize(join(srcDir, '.cache/babel/plugin.js'))
    );
    expect(files).not.toContain(
      normalize(join(srcDir, '.yarn/releases/yarn.cjs'))
    );
    expect(files).not.toContain(
      normalize(join(srcDir, '.pnpm-store/v3/files.ts'))
    );
    expect(files).not.toContain(
      normalize(join(srcDir, 'node_modules/pkg/index.ts'))
    );
    expect(files).toContain(normalize(join(srcDir, '.custom/step.ts')));
  });

  it('discovers files with various supported extensions in dot-directories', async () => {
    const srcDir = join(testRoot, 'src');
    writeFile(srcDir, '.api/route.tsx');
    writeFile(srcDir, '.api/handler.mts');
    writeFile(srcDir, '.api/utils.js');
    writeFile(srcDir, '.api/config.cjs');

    const builder = createBuilder(testRoot, ['src']);
    const files = (await builder.getInputFiles()).map(normalize);

    expect(files).toContain(normalize(join(srcDir, '.api/route.tsx')));
    expect(files).toContain(normalize(join(srcDir, '.api/handler.mts')));
    expect(files).toContain(normalize(join(srcDir, '.api/utils.js')));
    expect(files).toContain(normalize(join(srcDir, '.api/config.cjs')));
  });
});
