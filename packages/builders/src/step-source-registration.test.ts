import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import type { StandaloneConfig } from './types.js';

class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {
    // no-op
  }

  public createSourceStepRegistrations(
    inputFiles: string[],
    outfile: string,
    discoveredEntries: DiscoveredEntries
  ) {
    return this.createStepsBundle({
      inputFiles,
      outfile,
      externalizeNonSteps: true,
      bundleTransitiveLocalStepDependencies: false,
      sourceStepRegistrationImports: true,
      discoveredEntries,
    });
  }

  public createBundledSteps(
    inputFiles: string[],
    outfile: string,
    discoveredEntries: DiscoveredEntries
  ) {
    return this.createStepsBundle({
      inputFiles,
      outfile,
      format: 'esm',
      discoveredEntries,
    });
  }
}

const realTmpdir = realpathSync(tmpdir());

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

function createBuilder(
  workingDir: string,
  externalPackages?: string[]
): TestBuilder {
  const config: StandaloneConfig = {
    buildTarget: 'standalone',
    workingDir,
    dirs: ['.'],
    stepsBundlePath: join(workingDir, '.workflow', 'steps.js'),
    workflowsBundlePath: join(workingDir, '.workflow', 'workflows.js'),
    webhookBundlePath: join(workingDir, '.workflow', 'webhook.js'),
    externalPackages,
  };
  return new TestBuilder(config);
}

describe('step source registration', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-step-registration-'));
    writeFile(
      join(testRoot, 'node_modules', 'workflow', 'package.json'),
      JSON.stringify({ name: 'workflow', version: '1.0.0' })
    );
    writeFile(
      join(testRoot, 'node_modules', 'workflow', 'internal', 'builtins.js'),
      'export const __builtins = true;\n'
    );
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('imports serde-only files for step context class registration', async () => {
    const entryFile = join(testRoot, 'src', 'entry.ts');
    const stepFile = join(testRoot, 'src', 'step.ts');
    const serdeFile = join(testRoot, 'src', 'serde.ts');
    const outfile = join(testRoot, '.workflow', 'steps.js');

    mkdirSync(dirname(outfile), { recursive: true });
    writeFile(entryFile, `export { runStep } from './step';\n`);
    writeFile(
      stepFile,
      `export async function runStep() {
  'use step';
  return 1;
}
`
    );
    writeFile(
      serdeFile,
      `export class Value {
  static classId = 'Value';
  static [Symbol.for('workflow-serialize')](value: Value) {
    return value;
  }
  static [Symbol.for('workflow-deserialize')](value: Value) {
    return value;
  }
}
`
    );

    const discoveredEntries: DiscoveredEntries = {
      discoveredSteps: new Set([stepFile]),
      discoveredWorkflows: new Set(),
      discoveredSerdeFiles: new Set([serdeFile]),
    };

    const { manifest } = await createBuilder(
      testRoot
    ).createSourceStepRegistrations([entryFile], outfile, discoveredEntries);
    const generated = readFileSync(outfile, 'utf-8');

    expect(generated).toContain('import "workflow/internal/builtins";');
    expect(generated).toContain('import "../src/step.ts";');
    expect(generated).toContain('import "../src/serde.ts";');
    expect(Object.keys(manifest.classes ?? {})).toContain('src/serde.ts');
  });

  it('preserves import attributes for external packages in ESM bundles', async () => {
    const packageName = 'json-import-fixture';
    const packageDir = join(testRoot, 'node_modules', packageName);
    const stepFile = join(testRoot, 'src', 'step.ts');
    const outfile = join(testRoot, '.workflow', 'steps.mjs');

    writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: packageName,
        type: 'module',
        exports: './data.json',
      })
    );
    writeFile(join(packageDir, 'data.json'), JSON.stringify({ value: 42 }));
    writeFile(
      stepFile,
      `import data from '${packageName}' with { type: 'json' };

export async function readJson() {
  'use step';
  return data.value;
}
`
    );
    mkdirSync(dirname(outfile), { recursive: true });

    const discoveredEntries: DiscoveredEntries = {
      discoveredSteps: new Set([stepFile]),
      discoveredWorkflows: new Set(),
      discoveredSerdeFiles: new Set(),
    };

    await createBuilder(testRoot, [packageName]).createBundledSteps(
      [stepFile],
      outfile,
      discoveredEntries
    );

    const generated = readFileSync(outfile, 'utf-8');
    expect(generated).toContain(`from "${packageName}" with { type: "json" }`);
    await expect(import(pathToFileURL(outfile).href)).resolves.toBeDefined();
  });
});
