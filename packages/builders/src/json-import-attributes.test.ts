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
      // Import attributes only exist in ESM output; a CJS bundle turns the
      // JSON import into a `require` call.
      format: 'esm',
      externalizeNonSteps: true,
      bundleTransitiveLocalStepDependencies: false,
      rewriteTsExtensions: true,
      discoveredEntries,
    });
  }

  public createWorkflows(
    inputFiles: string[],
    outfile: string,
    discoveredEntries: DiscoveredEntries
  ) {
    return this.createWorkflowsBundle({
      inputFiles,
      outfile,
      bundleFinalOutput: false,
      discoveredEntries,
    });
  }
}

const realTmpdir = realpathSync(tmpdir());

const LOCAL_JSON_VALUE = 'hello from local json';
const DEP_JSON_VALUE = 'hello from dependency json';

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

/**
 * A project with a local JSON file and a dependency whose entry imports its
 * own JSON with an import attribute, mirroring `builtin-modules`.
 */
function writeJsonFixtures(testRoot: string): void {
  writeFile(
    join(testRoot, 'src', 'greeting.json'),
    JSON.stringify({ greeting: LOCAL_JSON_VALUE })
  );
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
    JSON.stringify({ fromDep: DEP_JSON_VALUE })
  );
  writeFile(
    join(testRoot, 'node_modules', 'json-attr-dep', 'index.js'),
    `import data from './data.json' with { type: 'json' };\nexport default data;\n`
  );
}

describe('JSON import attributes', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-json-attr-'));
    // The steps bundle is emitted as ESM, so Node has to load the generated
    // `.js` file as a module.
    writeFile(
      join(testRoot, 'package.json'),
      JSON.stringify({
        name: 'json-attr-fixture',
        version: '1.0.0',
        type: 'module',
      })
    );
    writeFile(
      join(testRoot, 'node_modules', 'workflow', 'package.json'),
      JSON.stringify({
        name: 'workflow',
        version: '1.0.0',
        type: 'module',
        exports: {
          './runtime': './runtime.js',
          './internal/builtins': './internal/builtins.js',
          './internal/private': './internal/private.js',
        },
      })
    );
    writeFile(
      join(testRoot, 'node_modules', 'workflow', 'internal', 'builtins.js'),
      'export const __builtins = true;\n'
    );
    // The steps bundle registers each step and re-exports the step route
    // handlers, so both entrypoints have to resolve for the bundle to load.
    writeFile(
      join(testRoot, 'node_modules', 'workflow', 'internal', 'private.js'),
      'export function registerStepFunction(fn) {\n  return fn;\n}\n'
    );
    writeFile(
      join(testRoot, 'node_modules', 'workflow', 'runtime.js'),
      'export function stepEntrypoint() {\n  return undefined;\n}\n'
    );
    writeJsonFixtures(testRoot);
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('applySwcTransform preserves `with { type: "json" }` attributes', async () => {
    const source = [
      `import data from './data.json' with { type: 'json' };`,
      `export default data;`,
    ].join('\n');

    for (const mode of [false, 'step', 'workflow'] as const) {
      const { code } = await applySwcTransform('index.js', source, mode);
      expect(code).toMatch(/with\s*\{\s*type:\s*['"]json['"]\s*\}/);
    }
  });

  it('keeps the attribute on externalized JSON imports so the steps bundle loads in Node', async () => {
    const stepFile = join(testRoot, 'src', 'step.ts');
    const outfile = join(testRoot, '.workflow', 'steps.js');
    mkdirSync(dirname(outfile), { recursive: true });
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

    await createBuilder(testRoot).createSteps([stepFile], outfile, {
      discoveredSteps: new Set([stepFile]),
      discoveredWorkflows: new Set(),
      discoveredSerdeFiles: new Set(),
    });

    const generated = readFileSync(outfile, 'utf-8');

    // The step file is bundled while the project-local JSON import stays
    // external as a relative path. Its attribute must survive both the SWC
    // transform and esbuild's output.
    expect(generated).toMatch(
      /import\s+\w+\s+from\s+"\.\.\/src\/greeting\.json"\s+with\s+\{\s*type:\s*"json"\s*\}/
    );
    expect(generated).not.toMatch(/from\s+"[^"]+\.json";/);

    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const mod = await import(${JSON.stringify(
          pathToFileURL(outfile).href
        )}); console.log(JSON.stringify(typeof mod.POST === 'function'));`,
      ],
      { encoding: 'utf8', cwd: testRoot }
    );
    expect(result.trim()).toBe('true');
  });

  it('inlines JSON imports into the workflow VM bundle', async () => {
    // The workflow VM has no module loader, so JSON reached from workflow code
    // must be inlined rather than left as an import.
    const workflowFile = join(testRoot, 'src', 'workflow.ts');
    const outfile = join(testRoot, '.workflow', 'workflows.js');
    mkdirSync(dirname(outfile), { recursive: true });
    writeFile(
      workflowFile,
      `import config from './greeting.json' with { type: 'json' };
import depData from 'json-attr-dep';

export async function greetWorkflow() {
  'use workflow';
  return config.greeting + ' / ' + depData.fromDep;
}
`
    );

    const { interimBundleText } = await createBuilder(testRoot).createWorkflows(
      [workflowFile],
      outfile,
      {
        discoveredSteps: new Set(),
        discoveredWorkflows: new Set([workflowFile]),
        discoveredSerdeFiles: new Set(),
      }
    );

    expect(interimBundleText).toContain(LOCAL_JSON_VALUE);
    expect(interimBundleText).toContain(DEP_JSON_VALUE);
    expect(interimBundleText).not.toMatch(/\.json["']/);
  });
});
