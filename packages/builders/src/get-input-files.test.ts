import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function writeFile(dir: string, relativePath: string, content = ''): string {
  const fullPath = join(dir, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
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
    const files = await builder.getInputFiles();

    expect(files).toContain(join(srcDir, '.hidden/step.ts'));
    expect(files).toContain(join(srcDir, '.config/workflow.ts'));
    expect(files).toContain(join(srcDir, 'regular/step.ts'));
  });

  it('discovers dot-prefixed files', async () => {
    const srcDir = join(testRoot, 'src');
    writeFile(srcDir, '.hidden-step.ts', "'use step';");
    writeFile(srcDir, 'visible-step.ts', "'use step';");

    const builder = createBuilder(testRoot, ['src']);
    const files = await builder.getInputFiles();

    expect(files).toContain(join(srcDir, '.hidden-step.ts'));
    expect(files).toContain(join(srcDir, 'visible-step.ts'));
  });

  it('still excludes explicitly ignored dot-directories', async () => {
    const srcDir = join(testRoot, 'src');
    writeFile(srcDir, '.git/hooks/pre-commit.ts');
    writeFile(srcDir, '.next/server/page.ts');
    writeFile(srcDir, '.vercel/output/step.ts');
    writeFile(srcDir, '.svelte-kit/output/step.ts');
    writeFile(srcDir, '.workflow-data/state.ts');
    writeFile(srcDir, '.well-known/workflow/route.ts');
    writeFile(srcDir, 'node_modules/pkg/index.ts');
    // This one should still be found
    writeFile(srcDir, '.custom/step.ts', "'use step';");

    const builder = createBuilder(testRoot, ['src']);
    const files = await builder.getInputFiles();

    expect(files).not.toContain(join(srcDir, '.git/hooks/pre-commit.ts'));
    expect(files).not.toContain(join(srcDir, '.next/server/page.ts'));
    expect(files).not.toContain(join(srcDir, '.vercel/output/step.ts'));
    expect(files).not.toContain(join(srcDir, '.svelte-kit/output/step.ts'));
    expect(files).not.toContain(join(srcDir, '.workflow-data/state.ts'));
    expect(files).not.toContain(join(srcDir, '.well-known/workflow/route.ts'));
    expect(files).not.toContain(join(srcDir, 'node_modules/pkg/index.ts'));
    expect(files).toContain(join(srcDir, '.custom/step.ts'));
  });

  it('discovers files with various supported extensions in dot-directories', async () => {
    const srcDir = join(testRoot, 'src');
    writeFile(srcDir, '.api/route.tsx');
    writeFile(srcDir, '.api/handler.mts');
    writeFile(srcDir, '.api/utils.js');
    writeFile(srcDir, '.api/config.cjs');

    const builder = createBuilder(testRoot, ['src']);
    const files = await builder.getInputFiles();

    expect(files).toContain(join(srcDir, '.api/route.tsx'));
    expect(files).toContain(join(srcDir, '.api/handler.mts'));
    expect(files).toContain(join(srcDir, '.api/utils.js'));
    expect(files).toContain(join(srcDir, '.api/config.cjs'));
  });
});
