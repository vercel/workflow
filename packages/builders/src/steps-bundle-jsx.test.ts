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
import { BaseBuilder } from './base-builder.js';
import type { StandaloneConfig } from './types.js';

class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {
    // no-op
  }

  public createSteps(
    stepFile: string,
    outfile: string,
    bundleTransitiveLocalStepDependencies: boolean
  ) {
    return this.createStepsBundle({
      inputFiles: [stepFile],
      outfile,
      externalizeNonSteps: true,
      bundleTransitiveLocalStepDependencies,
      rewriteTsExtensions: true,
      // No `discoveredEntries`: discovery builds the import graph that
      // transitive bundling uses to find the step's local dependencies.
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
    stepsBundlePath: join(workingDir, '.workflow', 'steps.mjs'),
    workflowsBundlePath: join(workingDir, '.workflow', 'workflows.mjs'),
    webhookBundlePath: join(workingDir, '.workflow', 'webhook.mjs'),
  };
  return new TestBuilder(config);
}

/**
 * Imports the bundle in a fresh Node process, the way Nitro dev loads it, and
 * runs the registered `render` step. Throws if Node cannot load the file.
 */
function runRenderStep(file: string, cwd: string): unknown {
  const stdout = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(pathToFileURL(file).href)});
const steps = globalThis[Symbol.for('@workflow/core//registeredSteps')];
console.log(JSON.stringify(await steps.get('step//./src/step//render')('joel')));`,
    ],
    { encoding: 'utf8', cwd, stdio: 'pipe' }
  );
  return JSON.parse(stdout.trim());
}

describe('steps bundle JSX (vercel/workflow#5286)', () => {
  let testRoot: string;
  let outfile: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-steps-jsx-'));
    outfile = join(testRoot, '.workflow', 'steps.mjs');
    writeFile(
      join(testRoot, 'node_modules', 'workflow', 'package.json'),
      JSON.stringify({ name: 'workflow', version: '1.0.0' })
    );
    writeFile(
      join(testRoot, 'node_modules', 'workflow', 'internal', 'builtins.js'),
      'export const __builtins = true;\n'
    );
    // Minimal JSX runtimes, so the compiled `jsx-runtime` imports resolve.
    for (const pkg of ['react', 'preact']) {
      writeFile(
        join(testRoot, 'node_modules', pkg, 'package.json'),
        JSON.stringify({
          name: pkg,
          version: '1.0.0',
          type: 'module',
          exports: { './jsx-runtime': './jsx-runtime.js' },
        })
      );
      writeFile(
        join(testRoot, 'node_modules', pkg, 'jsx-runtime.js'),
        `export const jsx = (type, props) => ({ runtime: '${pkg}', type, props });\nexport const jsxs = jsx;\nexport const Fragment = Symbol('Fragment');\n`
      );
    }
    // A step that reaches a .tsx file through a plain .ts module, the shape
    // from the issue (step -> a.ts -> b.tsx).
    writeFile(
      join(testRoot, 'src', 'b.tsx'),
      'export function Greeting({ name }: { name: string }) {\n  return <p>Hello {name}</p>;\n}\n'
    );
    writeFile(
      join(testRoot, 'src', 'a.ts'),
      "import { Greeting } from './b';\nexport const greeting = (name: string) => Greeting({ name });\n"
    );
    writeFile(
      join(testRoot, 'src', 'step.ts'),
      "import { greeting } from './a';\nexport async function render(name: string) {\n  'use step';\n  return greeting(name);\n}\n"
    );
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('compiles JSX in bundled local imports when the output is loaded directly', async () => {
    writeFile(
      join(testRoot, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { jsx: 'preserve' } })
    );

    await createBuilder(testRoot).createSteps(
      join(testRoot, 'src', 'step.ts'),
      outfile,
      true
    );

    const generated = readFileSync(outfile, 'utf-8');
    expect(generated).not.toContain('<p>');
    expect(runRenderStep(outfile, testRoot)).toMatchObject({
      runtime: 'react',
      type: 'p',
    });
  });

  it("honors the tsconfig's jsxImportSource", async () => {
    writeFile(
      join(testRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' },
      })
    );

    await createBuilder(testRoot).createSteps(
      join(testRoot, 'src', 'step.ts'),
      outfile,
      true
    );

    const generated = readFileSync(outfile, 'utf-8');
    expect(generated).not.toContain('<p>');
    expect(runRenderStep(outfile, testRoot)).toMatchObject({
      runtime: 'preact',
      type: 'p',
    });
  });

  it('leaves JSX preserved when a later bundler compiles the output', async () => {
    // Without transitive bundling, the steps bundle is input to another
    // bundler (Nitro/Rollup in prod). A .tsx step file's own JSX stays as-is,
    // as it did before.
    writeFile(
      join(testRoot, 'src', 'step.tsx'),
      "export async function render(name: string) {\n  'use step';\n  return <p>Hello {name}</p>;\n}\n"
    );

    await createBuilder(testRoot).createSteps(
      join(testRoot, 'src', 'step.tsx'),
      outfile,
      false
    );

    expect(readFileSync(outfile, 'utf-8')).toContain('<p>');
  });
});
