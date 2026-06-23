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
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import {
  importParents,
  parentHasChild,
} from './discover-entries-esbuild-plugin.js';
import type { StandaloneConfig } from './types.js';

class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {
    // no-op
  }

  public discoverEntriesPublic(
    inputs: string[],
    outdir: string,
    tsconfigPath?: string
  ): Promise<DiscoveredEntries> {
    return this.discoverEntries(inputs, outdir, tsconfigPath);
  }

  public createRouteImportSpecifierPublic(
    file: string,
    routeDir: string
  ): string {
    return this.createRouteImportSpecifier(file, routeDir);
  }
}

const realTmpdir = realpathSync(tmpdir());

function normalize(path: string): string {
  return path.replace(/\\/g, '/');
}

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

function createBuilder(workingDir: string): TestBuilder {
  const config: StandaloneConfig = {
    buildTarget: 'standalone',
    workingDir,
    dirs: ['.'],
    stepsBundlePath: join(workingDir, 'steps.js'),
    workflowsBundlePath: join(workingDir, 'workflows.js'),
    webhookBundlePath: join(workingDir, 'webhook.js'),
  };
  return new TestBuilder(config);
}

describe('fast workflow discovery', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-fast-discovery-'));
    importParents.clear();
  });

  afterEach(() => {
    importParents.clear();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('discovers transitive relative step imports and tracks the parent chain', async () => {
    const entryFile = join(testRoot, 'src', 'entry.ts');
    const workflowFile = join(testRoot, 'src', 'workflow.ts');
    const stepFile = join(testRoot, 'src', 'step.ts');

    writeFile(entryFile, `import './workflow';\n`);
    writeFile(workflowFile, `import { doStep } from './step';\nvoid doStep;\n`);
    writeFile(
      stepFile,
      `export async function doStep() {
  'use step';
  return 1;
}
`
    );

    const discovered = await createBuilder(testRoot).discoverEntriesPublic(
      [entryFile],
      join(testRoot, 'out')
    );

    expect(discovered.discoveredSteps).toEqual(new Set([normalize(stepFile)]));
    expect(parentHasChild(normalize(entryFile), normalize(stepFile))).toBe(
      true
    );
  });

  it('discovers workflow files reached through an imported package re-export', async () => {
    const entryFile = join(testRoot, 'src', 'entry.ts');
    const packageRoot = join(testRoot, 'node_modules', 'workflow-pkg');
    const packageIndex = join(packageRoot, 'index.js');
    const packageWorkflow = join(packageRoot, 'workflow.js');

    writeFile(entryFile, `import { run } from 'workflow-pkg';\nvoid run;\n`);
    writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'workflow-pkg',
        version: '1.0.0',
        main: 'index.js',
        dependencies: {
          workflow: '^1.0.0',
        },
      })
    );
    writeFile(packageIndex, `export { run } from './workflow.js';\n`);
    writeFile(
      packageWorkflow,
      `export async function run() {
  "use workflow";
  return "ok";
}
`
    );

    const discovered = await createBuilder(testRoot).discoverEntriesPublic(
      [entryFile],
      join(testRoot, 'out')
    );

    expect(discovered.discoveredWorkflows).toEqual(
      new Set([normalize(packageWorkflow)])
    );
    expect(
      parentHasChild(normalize(packageIndex), normalize(packageWorkflow))
    ).toBe(true);
  });

  it('discovers files reached through tsconfig path aliases', async () => {
    const entryFile = join(testRoot, 'src', 'entry.ts');
    const registryFile = join(testRoot, 'src', '_workflows.ts');
    const workflowFile = join(testRoot, 'src', 'workflows', 'workflow.ts');
    const tsconfigFile = join(testRoot, 'tsconfig.json');

    writeFile(
      tsconfigFile,
      JSON.stringify({
        compilerOptions: {
          paths: {
            '@/*': ['./src/*'],
          },
        },
      })
    );
    writeFile(entryFile, `import { allWorkflows } from '@/_workflows';\n`);
    writeFile(
      registryFile,
      `import * as workflow from './workflows/workflow';
export const allWorkflows = { workflow };
`
    );
    writeFile(
      workflowFile,
      `export async function run() {
  'use workflow';
  return 'ok';
}
`
    );

    const discovered = await createBuilder(testRoot).discoverEntriesPublic(
      [entryFile],
      join(testRoot, 'out'),
      tsconfigFile
    );

    expect(discovered.discoveredWorkflows).toEqual(
      new Set([normalize(workflowFile)])
    );
    expect(parentHasChild(normalize(entryFile), normalize(workflowFile))).toBe(
      true
    );
  });

  it('discovers path aliases inherited through tsconfig extends', async () => {
    const entryFile = join(testRoot, 'src', 'entry.ts');
    const workflowFile = join(testRoot, 'src', 'workflows', 'workflow.ts');
    const baseTsconfigFile = join(testRoot, 'tsconfig.base.json');
    const tsconfigFile = join(testRoot, 'tsconfig.json');

    writeFile(
      baseTsconfigFile,
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@base/*': ['./src/*'],
          },
        },
      })
    );
    writeFile(
      tsconfigFile,
      JSON.stringify({
        extends: './tsconfig.base.json',
      })
    );
    writeFile(entryFile, `import { run } from '@base/workflows/workflow';\n`);
    writeFile(
      workflowFile,
      `export async function run() {
  'use workflow';
  return 'ok';
}
`
    );

    const discovered = await createBuilder(testRoot).discoverEntriesPublic(
      [entryFile],
      join(testRoot, 'out'),
      tsconfigFile
    );

    expect(discovered.discoveredWorkflows).toEqual(
      new Set([normalize(workflowFile)])
    );
  });

  it('discovers path aliases with multiple wildcards', async () => {
    const entryFile = join(testRoot, 'src', 'entry.ts');
    const workflowFile = join(
      testRoot,
      'src',
      'features',
      'billing',
      'flows',
      'charge.ts'
    );
    const tsconfigFile = join(testRoot, 'tsconfig.json');

    writeFile(
      tsconfigFile,
      JSON.stringify({
        compilerOptions: {
          paths: {
            '@feature/*/workflow/*': ['./src/features/*/flows/*'],
          },
        },
      })
    );
    writeFile(
      entryFile,
      `import { charge } from '@feature/billing/workflow/charge';\n`
    );
    writeFile(
      workflowFile,
      `export async function charge() {
  'use workflow';
  return 'ok';
}
`
    );

    const discovered = await createBuilder(testRoot).discoverEntriesPublic(
      [entryFile],
      join(testRoot, 'out'),
      tsconfigFile
    );

    expect(discovered.discoveredWorkflows).toEqual(
      new Set([normalize(workflowFile)])
    );
  });

  it('uses nearest nested jsconfig aliases in monorepo packages', async () => {
    const rootTsconfigFile = join(testRoot, 'tsconfig.json');
    const packageRoot = join(testRoot, 'packages', 'app');
    const entryFile = join(packageRoot, 'src', 'entry.js');
    const workflowFile = join(packageRoot, 'src', 'workflow.js');

    writeFile(
      rootTsconfigFile,
      JSON.stringify({
        compilerOptions: {
          paths: {
            '@root/*': ['./root/*'],
          },
        },
      })
    );
    writeFile(
      join(packageRoot, 'jsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          paths: {
            '#/*': ['./src/*'],
          },
        },
      })
    );
    writeFile(entryFile, `import { run } from '#/workflow';\n`);
    writeFile(
      workflowFile,
      `export async function run() {
  "use workflow";
  return "ok";
}
`
    );

    const discovered = await createBuilder(testRoot).discoverEntriesPublic(
      [entryFile],
      join(testRoot, 'out')
    );

    expect(discovered.discoveredWorkflows).toEqual(
      new Set([normalize(workflowFile)])
    );
  });

  it('only treats serde files as registration candidates when they define static serde methods', async () => {
    const entryFile = join(testRoot, 'src', 'entry.ts');
    const reducerFile = join(testRoot, 'src', 'reducer.ts');
    const serdeFile = join(testRoot, 'src', 'serde.ts');

    writeFile(
      entryFile,
      `import './reducer';
import './serde';
`
    );
    writeFile(
      reducerFile,
      `import { WORKFLOW_SERIALIZE } from '@workflow/serde';

export function reducer(value: unknown) {
  return value?.constructor?.[WORKFLOW_SERIALIZE];
}
`
    );
    writeFile(
      serdeFile,
      `import { WORKFLOW_SERIALIZE as WS } from '@workflow/serde';

export class Value {
  static classId = 'Value';
  static [WS](value: Value) {
    return value;
  }
}
`
    );

    const discovered = await createBuilder(testRoot).discoverEntriesPublic(
      [entryFile],
      join(testRoot, 'out')
    );

    expect(discovered.discoveredSerdeFiles).toEqual(
      new Set([normalize(serdeFile)])
    );
  });

  it('categorizes step, workflow, and serde usage independently', async () => {
    const entryFile = join(testRoot, 'src', 'entry.ts');
    const stepFile = join(testRoot, 'src', 'step.ts');
    const workflowFile = join(testRoot, 'src', 'workflow.ts');
    const serdeFile = join(testRoot, 'src', 'serde.ts');

    writeFile(
      entryFile,
      `import './step';
import './workflow';
import './serde';
`
    );
    writeFile(
      stepFile,
      `export async function runStep() {
  'use step';
  return 'ok';
}
`
    );
    writeFile(
      workflowFile,
      `export async function runWorkflow() {
  'use workflow';
  return 'ok';
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
}
`
    );

    const discovered = await createBuilder(testRoot).discoverEntriesPublic(
      [entryFile],
      join(testRoot, 'out')
    );

    expect(discovered.discoveredSteps).toEqual(new Set([normalize(stepFile)]));
    expect(discovered.discoveredWorkflows).toEqual(
      new Set([normalize(workflowFile)])
    );
    expect(discovered.discoveredSerdeFiles).toEqual(
      new Set([normalize(serdeFile)])
    );
  });

  it('ignores serde examples that only appear inside comments', async () => {
    const entryFile = join(testRoot, 'src', 'entry.ts');
    const docsFile = join(testRoot, 'src', 'docs.ts');

    writeFile(entryFile, `import './docs';\n`);
    writeFile(
      docsFile,
      `/**
 * import { WORKFLOW_SERIALIZE } from '@workflow/serde';
 *
 * class Example {
 *   static [WORKFLOW_SERIALIZE](value) {
 *     return value;
 *   }
 * }
 */
export const WORKFLOW_SERIALIZE = Symbol.for('workflow-serialize');
`
    );

    const discovered = await createBuilder(testRoot).discoverEntriesPublic(
      [entryFile],
      join(testRoot, 'out')
    );

    expect(discovered.discoveredSerdeFiles).toEqual(new Set());
  });

  it('relativizes nested package step registration imports', () => {
    const routeDir = join(testRoot, 'app', '.well-known', 'workflow', 'v1');
    const directPackageFile = join(
      testRoot,
      'node_modules',
      'direct-pkg',
      'step.js'
    );
    const nestedPackageFile = join(
      testRoot,
      'node_modules',
      'parent-pkg',
      'node_modules',
      'nested-pkg',
      'step.js'
    );

    writeFile(
      join(testRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          'direct-pkg': '1.0.0',
        },
      })
    );
    writeFile(
      join(testRoot, 'node_modules', 'direct-pkg', 'package.json'),
      JSON.stringify({
        name: 'direct-pkg',
        version: '1.0.0',
        exports: {
          './step': './step.js',
        },
      })
    );
    writeFile(directPackageFile, `export const step = true;\n`);
    writeFile(
      join(
        testRoot,
        'node_modules',
        'parent-pkg',
        'node_modules',
        'nested-pkg',
        'package.json'
      ),
      JSON.stringify({
        name: 'nested-pkg',
        version: '1.0.0',
        exports: {
          './step': './step.js',
        },
      })
    );
    writeFile(nestedPackageFile, `export const step = true;\n`);

    const builder = createBuilder(testRoot);
    expect(
      builder.createRouteImportSpecifierPublic(directPackageFile, routeDir)
    ).toBe('direct-pkg/step');
    expect(
      builder.createRouteImportSpecifierPublic(nestedPackageFile, routeDir)
    ).toBe(
      '../../../../node_modules/parent-pkg/node_modules/nested-pkg/step.js'
    );
  });
});
