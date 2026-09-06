import { execFileSync } from 'node:child_process';
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
import { applySwcTransform } from './apply-swc-transform.js';
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import type { StandaloneConfig } from './types.js';

class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {
    // no-op
  }

  public createSteps(
    inputFiles: string[],
    outfile: string,
    discoveredEntries: DiscoveredEntries
  ) {
    return this.createStepsBundle({
      inputFiles,
      outfile,
      externalizeNonSteps: true,
      bundleTransitiveLocalStepDependencies: false,
      rewriteTsExtensions: true,
      discoveredEntries,
    });
  }
}

const realTmpdir = realpathSync(tmpdir());

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

function createBuilder(workingDir: string): TestBuilder {
  const config: StandaloneConfig = {
    buildTarget: 'standalone',
    workingDir,
    dirs: ['.'],
    stepsBundlePath: join(workingDir, '.workflow', 'steps.js'),
    workflowsBundlePath: join(workingDir, '.workflow', 'workflows.js'),
    webhookBundlePath: join(workingDir, '.workflow', 'webhook.js'),
  };
  return new TestBuilder(config);
}

describe('JSON import attributes (issue #3157)', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-json-attr-'));
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

  it('applySwcTransform preserves `with { type: "json" }` attributes', async () => {
    const source = [
      `import data from './data.json' with { type: 'json' };`,
      `export default data;`,
    ].join('\n');

    const { code } = await applySwcTransform('index.js', source, false);

    expect(code).toMatch(/with\s*\{\s*type:\s*'json'\s*\}/);
  });

  it('keeps the attribute on externalized JSON imports so the steps bundle executes', async () => {
    const stepFile = join(testRoot, 'src', 'step.ts');
    const jsonFile = join(testRoot, 'src', 'greeting.json');
    const outfile = join(testRoot, '.workflow', 'steps.js');

    mkdirSync(dirname(outfile), { recursive: true });
    writeFile(jsonFile, JSON.stringify({ greeting: 'hello from json' }));
    // A dependency-shaped module whose entry uses a JSON import attribute,
    // mirroring `builtin-modules` from the issue report.
    writeFile(
      join(testRoot, 'node_modules', 'json-attr-dep', 'package.json'),
      JSON.stringify({
        name: 'json-attr-dep',
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
      })
    );
    writeFile(
      join(testRoot, 'node_modules', 'json-attr-dep', 'data.json'),
      JSON.stringify({ fromDep: 'dep json' })
    );
    writeFile(
      join(testRoot, 'node_modules', 'json-attr-dep', 'index.js'),
      `import data from './data.json' with { type: 'json' };\nexport default data;\n`
    );
    writeFile(
      stepFile,
      `import config from './greeting.json' with { type: 'json' };
import depData from 'json-attr-dep';

export async function greet() {
  'use step';
  return config.greeting + ' / ' + depData.fromDep;
}
`
    );

    const discoveredEntries: DiscoveredEntries = {
      discoveredSteps: new Set([stepFile]),
      discoveredWorkflows: new Set(),
      discoveredSerdeFiles: new Set(),
    };

    await createBuilder(testRoot).createSteps(
      [stepFile],
      outfile,
      discoveredEntries
    );

    const generated = readFileSync(outfile, 'utf-8');

    // The step file is bundled (and SWC-transformed) while the project-local
    // JSON import is externalized as a relative path. The import attribute
    // must survive both the SWC transform and esbuild's output generation,
    // otherwise Node's ESM loader throws ERR_IMPORT_ATTRIBUTE_MISSING when
    // the local runtime loads the steps bundle.
    expect(generated).toMatch(
      /import\s+\w+\s+from\s+"\.\.\/src\/greeting\.json"\s+with\s+\{\s*type:\s*"json"\s*\}/
    );

    // The bundle must actually load under Node's native ESM loader.
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const mod = await import(${JSON.stringify(
          pathToFileURL(outfile).href
        )}); console.log(JSON.stringify(mod.__steps_registered));`,
      ],
      { encoding: 'utf8', cwd: testRoot }
    );
    expect(result.trim()).toBe('true');
  });
});
