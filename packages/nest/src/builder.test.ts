import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NestLocalBuilder } from './builder.js';

const BUILD_TIMEOUT = 120_000;

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

/**
 * Minimal stand-in for the `workflow` package so the builder can resolve its
 * runtime imports inside the temp app. Mirrors the stub in
 * `@workflow/builders`' vercel-build-output-api tests.
 */
async function writeWorkflowRuntimeStub(workingDir: string): Promise<void> {
  const packageDir = join(workingDir, 'node_modules/workflow');
  await write(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'workflow',
      version: '1.0.0',
      type: 'module',
      exports: {
        './api': './api.js',
        './internal/builtins': './internal/builtins.js',
        './runtime': './runtime.js',
      },
    })
  );
  await write(
    join(packageDir, 'api.js'),
    'export async function resumeWebhook() { return new Response(null, { status: 204 }); }\n'
  );
  await write(
    join(packageDir, 'internal/builtins.js'),
    'export const __workflow_builtins = true;\n'
  );
  await write(
    join(packageDir, 'runtime.js'),
    'export function workflowEntrypoint() { return async function POST() { return new Response(null, { status: 204 }); }; }\n'
  );
}

/**
 * A NestJS-shaped app compiled to CommonJS: a step that imports a non-step
 * service from the same `src/` tree (so the builder externalizes it and the
 * CJS rewrite turns the import into a `require()`), plus the `dist/` output
 * `nest build` would have produced for that service.
 */
async function writeCjsApp(workingDir: string): Promise<void> {
  await writeWorkflowRuntimeStub(workingDir);
  await write(
    join(workingDir, 'src/services/greeter.service.ts'),
    `export class GreeterService {
  greet(): string {
    return 'hello from dist';
  }
}
`
  );
  await write(
    join(workingDir, 'src/workflows/greet.ts'),
    `import { GreeterService } from '../services/greeter.service';

export async function greetStep(): Promise<string> {
  'use step';
  return new GreeterService().greet();
}

export async function greetWorkflow(): Promise<string> {
  'use workflow';
  return greetStep();
}
`
  );
  // What `nest build` (SWC, module: commonjs) emits for the service. The
  // `_export` wrapper is the shape cjs-module-lexer cannot read, which is the
  // whole reason the steps bundle rewrites these imports to require().
  await write(
    join(workingDir, 'dist/services/greeter.service.js'),
    `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function _export(target, all) {
  for (var name in all) Object.defineProperty(target, name, { enumerable: true, get: all[name] });
}
_export(exports, {
  GreeterService: () => GreeterService
});
class GreeterService {
  greet() {
    return 'hello from dist';
  }
}
`
  );
}

async function buildCjsStepsBundle(workingDir: string): Promise<string> {
  await writeCjsApp(workingDir);

  const builder = new NestLocalBuilder({
    workingDir,
    dirs: ['src'],
    moduleType: 'commonjs',
    distDir: 'dist',
  });
  await builder.build();

  return join(builder.outDir, 'steps.mjs');
}

/**
 * Import the steps bundle in a fresh Node process and invoke the step it
 * registered, returning what the step resolved to.
 *
 * A subprocess rather than a dynamic `import()` in-process because the bundle
 * registers into a global keyed by a `Symbol.for`, and because a bundle that
 * fails to parse should surface as a failed child process rather than poison
 * the vitest worker.
 */
async function runFirstRegisteredStep(
  workingDir: string,
  stepsPath: string
): Promise<string> {
  const runnerPath = join(workingDir, 'run-step.mjs');
  await write(
    runnerPath,
    `import { pathToFileURL } from 'node:url';

await import(pathToFileURL(process.argv[2]).href);

const registry = globalThis[Symbol.for('@workflow/core//registeredSteps')];
const [step] = [...(registry?.values() ?? [])];
if (typeof step !== 'function') {
  throw new Error('steps bundle registered no step');
}
process.stdout.write(String(await step()));
`
  );

  return execFileSync(process.execPath, [runnerPath, stepsPath], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

describe('NestLocalBuilder CommonJS steps bundle', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(realpathSync(tmpdir()), 'workflow-nest-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it(
    'declares `require` exactly once',
    { timeout: BUILD_TIMEOUT },
    async () => {
      const stepsPath = await buildCjsStepsBundle(workingDir);
      const bundle = await readFile(stepsPath, 'utf8');

      // The rewrite must have actually fired, otherwise the assertions below
      // pass vacuously on a bundle that never needed a `require` at all.
      expect(bundle).toMatch(/require\("\.\.\/\.\.\/dist\/services\/greeter/);

      // Regression guard for #3778: the CJS rewrite must not add a `require`
      // declaration of its own on top of the ESM interop banner's. Two
      // declarations in one module scope is a parse error, and the build
      // reports success either way, so only the bundle itself can tell us.
      expect(bundle.match(/^(?:const|let|var) require = /gm)).toHaveLength(1);

      // The banner is what supplies `require`, and it supplies
      // `__dirname`/`__filename` in the same breath. Skipping the banner is
      // therefore NOT an alternative fix for the duplicate declaration — it
      // would reintroduce `ReferenceError: __dirname is not defined in ES
      // module scope` for CJS deps that read those at module scope.
      expect(bundle).toContain('var __filename = __fileURLToPath(');
      expect(bundle).toContain('var __dirname = __pathDirname(');
    }
  );

  it(
    'loads under Node and runs a step through the rewritten require',
    { timeout: BUILD_TIMEOUT },
    async () => {
      const stepsPath = await buildCjsStepsBundle(workingDir);

      // End-to-end cover for `moduleType: 'commonjs'`: the bundle parses, the
      // rewritten `require()` resolves to the compiled file in distDir, and the
      // named export is readable through it — which is the thing a plain ESM
      // import cannot do, since cjs-module-lexer does not understand SWC's
      // `_export()` wrapper. The build reports success regardless of all three,
      // so nothing short of loading the bundle catches a break here.
      await expect(runFirstRegisteredStep(workingDir, stepsPath)).resolves.toBe(
        'hello from dist'
      );
    }
  );
});
