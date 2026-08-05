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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseBuilder } from './base-builder.js';
import type { StandaloneConfig } from './types.js';

const realTmpdir = realpathSync(tmpdir());

class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {
    // no-op
  }

  public bundleSteps(inputFiles: string[], outfile: string) {
    return this.createStepsBundle({ inputFiles, outfile });
  }

  public bundleWorkflows(inputFiles: string[], outfile: string) {
    return this.createWorkflowsBundle({ inputFiles, outfile });
  }
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
    stepsBundlePath: join(workingDir, '.workflow', 'steps.js'),
    workflowsBundlePath: join(workingDir, '.workflow', 'workflows.js'),
    webhookBundlePath: join(workingDir, '.workflow', 'webhook.js'),
  };
  return new TestBuilder(config);
}

describe('Markdown loader', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-markdown-loader-'));
    const workflowPackageDir = join(testRoot, 'node_modules', 'workflow');
    mkdirSync(join(workflowPackageDir, 'internal'), { recursive: true });
    writeFile(
      join(workflowPackageDir, 'package.json'),
      JSON.stringify({
        name: 'workflow',
        type: 'module',
        exports: {
          './internal/builtins': './internal/builtins.js',
          './runtime': './runtime.js',
        },
      })
    );
    writeFile(
      join(workflowPackageDir, 'internal', 'builtins.js'),
      'export {};'
    );
    writeFile(
      join(workflowPackageDir, 'runtime.js'),
      'export const workflowEntrypoint = (handler) => handler;'
    );
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('embeds a static Markdown import in both step and workflow bundles', async () => {
    const entryFile = join(testRoot, 'src', 'entry.ts');
    const promptFile = join(testRoot, 'src', 'instructions.md');
    const stepsOutfile = join(testRoot, '.workflow', 'steps.js');
    const workflowsOutfile = join(testRoot, '.workflow', 'workflows.js');

    mkdirSync(dirname(stepsOutfile), { recursive: true });
    writeFile(promptFile, '# Bundled instruction\n');
    writeFile(
      entryFile,
      `import instructions from './instructions.md';

console.log(instructions);

export async function runStep() {
  'use step';
  return instructions;
}

export async function runWorkflow() {
  'use workflow';
  return instructions;
}
`
    );

    const builder = createBuilder(testRoot);
    await builder.bundleSteps([entryFile], stepsOutfile);
    const workflows = await builder.bundleWorkflows(
      [entryFile],
      workflowsOutfile
    );

    expect(readFileSync(stepsOutfile, 'utf-8')).toContain(
      '# Bundled instruction'
    );
    expect(workflows.interimBundleText).toContain('# Bundled instruction');
  });
});
