import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import type { StandaloneConfig } from './types.js';

/**
 * Minimal subclass to expose the protected `discoverEntries()` for testing.
 */
class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {
    // no-op
  }

  // Expose for tests
  public discoverEntriesPublic(
    inputs: string[],
    outdir: string
  ): Promise<DiscoveredEntries> {
    return this.discoverEntries(inputs, outdir);
  }
}

// Resolve symlinks in tmpdir to avoid macOS /var -> /private/var issues
const realTmpdir = realpathSync(tmpdir());

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

function createBuilder(
  workingDir: string,
  externalPackages: string[]
): TestBuilder {
  const config: StandaloneConfig = {
    buildTarget: 'standalone',
    workingDir,
    dirs: ['.'],
    externalPackages,
    stepsBundlePath: join(workingDir, 'steps.js'),
    workflowsBundlePath: join(workingDir, 'workflows.js'),
    webhookBundlePath: join(workingDir, 'webhook.js'),
  };
  return new TestBuilder(config);
}

describe('warnAboutExternalWorkflowPackages', () => {
  let testRoot: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-external-pkg-warning-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('warns when an external package depends on @workflow/serde', async () => {
    // Create a mock project with a node_modules package
    const projectDir = join(testRoot, 'project');

    // Create a minimal entry file for the project
    writeFile(join(projectDir, 'index.ts'), 'export const x = 1;');

    // Create the external package with @workflow/serde dependency
    writeFile(
      join(projectDir, 'node_modules', 'my-serde-pkg', 'package.json'),
      JSON.stringify({
        name: 'my-serde-pkg',
        version: '1.0.0',
        main: 'index.js',
        dependencies: {
          '@workflow/serde': '^1.0.0',
        },
      })
    );
    writeFile(
      join(projectDir, 'node_modules', 'my-serde-pkg', 'index.js'),
      'export class Foo {}'
    );

    const builder = createBuilder(projectDir, ['my-serde-pkg']);
    await builder.discoverEntriesPublic(
      [join(projectDir, 'index.ts')],
      join(projectDir, 'out')
    );

    expect(warnSpy).toHaveBeenCalled();
    const warnMessage = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMessage).toContain('my-serde-pkg');
    expect(warnMessage).toContain('serverExternalPackages');
    expect(warnMessage).toContain('serialization classes');
  });

  it('warns when an external package source contains serde symbols', async () => {
    const projectDir = join(testRoot, 'project');

    writeFile(join(projectDir, 'index.ts'), 'export const x = 1;');

    // Package without @workflow/serde dep but with Symbol.for patterns in source
    writeFile(
      join(projectDir, 'node_modules', 'my-symbol-pkg', 'package.json'),
      JSON.stringify({
        name: 'my-symbol-pkg',
        version: '1.0.0',
        main: 'index.js',
      })
    );
    writeFile(
      join(projectDir, 'node_modules', 'my-symbol-pkg', 'index.js'),
      `export class Bar {
  static [Symbol.for('workflow-serialize')](instance) { return {}; }
  static [Symbol.for('workflow-deserialize')](data) { return new Bar(); }
}`
    );

    const builder = createBuilder(projectDir, ['my-symbol-pkg']);
    await builder.discoverEntriesPublic(
      [join(projectDir, 'index.ts')],
      join(projectDir, 'out')
    );

    expect(warnSpy).toHaveBeenCalled();
    const warnMessage = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMessage).toContain('my-symbol-pkg');
    expect(warnMessage).toContain('serialization classes');
  });

  it('warns when an external package contains "use step" directives', async () => {
    const projectDir = join(testRoot, 'project');

    writeFile(join(projectDir, 'index.ts'), 'export const x = 1;');

    writeFile(
      join(projectDir, 'node_modules', 'my-step-pkg', 'package.json'),
      JSON.stringify({
        name: 'my-step-pkg',
        version: '1.0.0',
        main: 'index.js',
      })
    );
    writeFile(
      join(projectDir, 'node_modules', 'my-step-pkg', 'index.js'),
      `export async function doWork() {
  "use step";
  return 42;
}`
    );

    const builder = createBuilder(projectDir, ['my-step-pkg']);
    await builder.discoverEntriesPublic(
      [join(projectDir, 'index.ts')],
      join(projectDir, 'out')
    );

    expect(warnSpy).toHaveBeenCalled();
    const warnMessage = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMessage).toContain('my-step-pkg');
    expect(warnMessage).toContain('"use step" functions');
  });

  it('warns when an external package contains "use workflow" directives', async () => {
    const projectDir = join(testRoot, 'project');

    writeFile(join(projectDir, 'index.ts'), 'export const x = 1;');

    writeFile(
      join(projectDir, 'node_modules', 'my-workflow-pkg', 'package.json'),
      JSON.stringify({
        name: 'my-workflow-pkg',
        version: '1.0.0',
        main: 'index.js',
      })
    );
    writeFile(
      join(projectDir, 'node_modules', 'my-workflow-pkg', 'index.js'),
      `export async function runJob() {
  "use workflow";
  return "done";
}`
    );

    const builder = createBuilder(projectDir, ['my-workflow-pkg']);
    await builder.discoverEntriesPublic(
      [join(projectDir, 'index.ts')],
      join(projectDir, 'out')
    );

    expect(warnSpy).toHaveBeenCalled();
    const warnMessage = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMessage).toContain('my-workflow-pkg');
    expect(warnMessage).toContain('"use workflow" functions');
  });

  it('does not warn for packages without workflow patterns', async () => {
    const projectDir = join(testRoot, 'project');

    writeFile(join(projectDir, 'index.ts'), 'export const x = 1;');

    writeFile(
      join(projectDir, 'node_modules', 'plain-pkg', 'package.json'),
      JSON.stringify({
        name: 'plain-pkg',
        version: '1.0.0',
        main: 'index.js',
      })
    );
    writeFile(
      join(projectDir, 'node_modules', 'plain-pkg', 'index.js'),
      'export const hello = "world";'
    );

    const builder = createBuilder(projectDir, ['plain-pkg']);
    await builder.discoverEntriesPublic(
      [join(projectDir, 'index.ts')],
      join(projectDir, 'out')
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn for pseudo-packages (server-only, client-only)', async () => {
    const projectDir = join(testRoot, 'project');

    writeFile(join(projectDir, 'index.ts'), 'export const x = 1;');

    const builder = createBuilder(projectDir, ['server-only', 'client-only']);
    await builder.discoverEntriesPublic(
      [join(projectDir, 'index.ts')],
      join(projectDir, 'out')
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn when externalPackages is empty', async () => {
    const projectDir = join(testRoot, 'project');

    writeFile(join(projectDir, 'index.ts'), 'export const x = 1;');

    const builder = createBuilder(projectDir, []);
    await builder.discoverEntriesPublic(
      [join(projectDir, 'index.ts')],
      join(projectDir, 'out')
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns only once per package across multiple discoverEntries calls', async () => {
    const projectDir = join(testRoot, 'project');

    writeFile(join(projectDir, 'index.ts'), 'export const x = 1;');
    writeFile(join(projectDir, 'other.ts'), 'export const y = 2;');

    writeFile(
      join(projectDir, 'node_modules', 'my-serde-pkg', 'package.json'),
      JSON.stringify({
        name: 'my-serde-pkg',
        version: '1.0.0',
        main: 'index.js',
        dependencies: { '@workflow/serde': '^1.0.0' },
      })
    );
    writeFile(
      join(projectDir, 'node_modules', 'my-serde-pkg', 'index.js'),
      'export class Foo {}'
    );

    const builder = createBuilder(projectDir, ['my-serde-pkg']);

    // Call discoverEntries twice with different inputs
    await builder.discoverEntriesPublic(
      [join(projectDir, 'index.ts')],
      join(projectDir, 'out')
    );
    await builder.discoverEntriesPublic(
      [join(projectDir, 'other.ts')],
      join(projectDir, 'out2')
    );

    // Should only warn once
    const warnCalls = warnSpy.mock.calls.filter((call: unknown[]) =>
      (call[0] as string).includes('my-serde-pkg')
    );
    expect(warnCalls).toHaveLength(1);
  });

  it('lists multiple detected issues in the warning message', async () => {
    const projectDir = join(testRoot, 'project');

    writeFile(join(projectDir, 'index.ts'), 'export const x = 1;');

    writeFile(
      join(projectDir, 'node_modules', 'multi-pkg', 'package.json'),
      JSON.stringify({
        name: 'multi-pkg',
        version: '1.0.0',
        main: 'index.js',
        dependencies: { '@workflow/serde': '^1.0.0' },
      })
    );
    writeFile(
      join(projectDir, 'node_modules', 'multi-pkg', 'index.js'),
      `export async function doWork() {
  "use step";
  return 42;
}
export class Foo {
  static [Symbol.for('workflow-serialize')](instance) { return {}; }
  static [Symbol.for('workflow-deserialize')](data) { return new Foo(); }
}`
    );

    const builder = createBuilder(projectDir, ['multi-pkg']);
    await builder.discoverEntriesPublic(
      [join(projectDir, 'index.ts')],
      join(projectDir, 'out')
    );

    expect(warnSpy).toHaveBeenCalled();
    const warnMessage = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMessage).toContain('"use step" functions');
    expect(warnMessage).toContain('serialization classes');
  });

  it('warns via entry-file detection when package.json has no serde dep', async () => {
    const projectDir = join(testRoot, 'project');

    writeFile(join(projectDir, 'index.ts'), 'export const x = 1;');

    // Package without @workflow/serde in deps, but entry has "use step"
    writeFile(
      join(projectDir, 'node_modules', 'no-serde-dep-pkg', 'package.json'),
      JSON.stringify({
        name: 'no-serde-dep-pkg',
        version: '1.0.0',
        main: 'index.js',
      })
    );
    writeFile(
      join(projectDir, 'node_modules', 'no-serde-dep-pkg', 'index.js'),
      `export async function doWork() {
  "use step";
  return 42;
}`
    );

    const builder = createBuilder(projectDir, ['no-serde-dep-pkg']);
    await builder.discoverEntriesPublic(
      [join(projectDir, 'index.ts')],
      join(projectDir, 'out')
    );

    expect(warnSpy).toHaveBeenCalled();
    const warnMessage = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMessage).toContain('no-serde-dep-pkg');
    expect(warnMessage).toContain('"use step" functions');
  });
});
