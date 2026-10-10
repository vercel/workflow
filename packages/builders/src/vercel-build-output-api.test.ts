import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VercelBuildOutputConfig } from './types.js';
import { VercelBuildOutputAPIBuilder } from './vercel-build-output-api.js';

const BUILD_TIMEOUT = 120_000;

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

function getFlowFuncDir(workingDir: string): string {
  return join(
    workingDir,
    '.vercel/output/functions/.well-known/workflow/v1/flow.func'
  );
}

function createBuilder(workingDir: string): VercelBuildOutputAPIBuilder {
  const config: VercelBuildOutputConfig = {
    buildTarget: 'vercel-build-output-api',
    workingDir,
    dirs: ['src'],
    stepsBundlePath: join(workingDir, 'unused-steps.mjs'),
    workflowsBundlePath: join(workingDir, 'unused-workflows.mjs'),
    webhookBundlePath: join(workingDir, 'unused-webhook.mjs'),
    suppressCreateManifestLogs: true,
  };
  return new VercelBuildOutputAPIBuilder(config);
}

function executeStep(workingDir: string, stepName: string): string {
  const bundleUrl = pathToFileURL(
    join(getFlowFuncDir(workingDir), 'index.mjs')
  ).href;
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(bundleUrl)});
await Promise.all(globalThis.__workflowStepLoaders.map((loader) => loader()));
const steps = globalThis[Symbol.for('@workflow/core//registeredSteps')];
const step = [...steps].find(([id]) => id.endsWith(${JSON.stringify(`//${stepName}`)}))?.[1];
if (!step) throw new Error(${JSON.stringify(`${stepName} step was not registered`)});
process.stdout.write(JSON.stringify(await step()));`,
    ],
    { encoding: 'utf8' }
  );
  return JSON.parse(output);
}

/**
 * Minimal stand-in for the `workflow` package so the builder can resolve
 * its runtime imports inside the temp app.
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
    'globalThis.__workflowStepLoaders = [];\nexport function workflowEntrypoint() { return async function POST() { return new Response(null, { status: 204 }); }; }\nexport function registerStepFunctionLoader(_stepId, loader) { globalThis.__workflowStepLoaders.push(loader); }\n'
  );
}

describe('VercelBuildOutputAPIBuilder ESM output', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(realpathSync(tmpdir()), 'workflow-vercel-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it(
    'executes a bundled CJS dependency that references __dirname at module scope',
    { timeout: BUILD_TIMEOUT },
    async () => {
      await writeWorkflowRuntimeStub(workingDir);

      // google-gax-shaped fixture: a CJS package that computes a path from
      // __dirname at module scope (google-gax/build/src/grpc.js does exactly
      // this), which crashed the whole function at init with
      // `ReferenceError: __dirname is not defined in ES module scope` when
      // inlined into the ESM bundle without the banner shim.
      const packageDir = join(workingDir, 'node_modules/fake-gax');
      await write(
        join(packageDir, 'package.json'),
        JSON.stringify({ name: 'fake-gax', version: '1.0.0', main: 'index.js' })
      );
      await write(
        join(packageDir, 'index.js'),
        `const path = require('path');
// Module-scope __dirname reference, like google-gax's grpc.js.
const protoFilesDir = path.join(__dirname, '..', 'protos');
exports.getProtoFilesDir = () => protoFilesDir;
exports.getFilename = () => __filename;
`
      );
      await write(
        join(workingDir, 'src/workflows/gax.ts'),
        `import { getProtoFilesDir, getFilename } from 'fake-gax';

export async function readDirs(): Promise<string> {
  'use step';
  return [getProtoFilesDir(), getFilename()].every((p) => typeof p === 'string' && p.length > 0)
    ? 'dirs-ok'
    : 'dirs-missing';
}

export async function gaxWorkflow(): Promise<string> {
  'use workflow';
  return readDirs();
}
`
      );

      await createBuilder(workingDir).build();

      // The bundle must be importable under plain Node (this is where the
      // unshimmed bundle throws, before any workflow code runs) and the step
      // must see defined __dirname/__filename values.
      expect(executeStep(workingDir, 'readDirs')).toBe('dirs-ok');

      // The shim is declared exactly once: the inner steps bundle skips its
      // banner when the outer combined pass provides one
      // (skipEsmRequireBanner), so the import bindings don't collide.
      //
      // Note this covers createCombinedBundle and createWebhookBundle. The
      // same banner is also emitted by createWorkflowsBundle's final wrapper,
      // which is not exercised here.
      const bundle = await readFile(
        join(getFlowFuncDir(workingDir), 'index.mjs'),
        'utf8'
      );
      // The import binding is the assertion that matters: a duplicated banner
      // fails at parse time on the redeclared import, before the `var` ever
      // runs.
      expect(
        bundle.match(/import \{ fileURLToPath as __fileURLToPath \}/g)
      ).toHaveLength(1);
      expect(
        bundle.match(/var __dirname = __pathDirname\(__filename\);/g)
      ).toHaveLength(1);

      // The webhook route is a separately deployed function built by the same
      // build() through its own esbuild pass (createWebhookBundle) — a CJS
      // dependency referencing __dirname reachable from it would have crashed
      // the same way, so it needs the shim too.
      const webhookBundle = await readFile(
        join(
          workingDir,
          '.vercel/output/functions/.well-known/workflow/v1/webhook/[token].func/index.mjs'
        ),
        'utf8'
      );
      expect(
        webhookBundle.match(/import \{ fileURLToPath as __fileURLToPath \}/g)
      ).toHaveLength(1);
      expect(
        webhookBundle.match(/var __dirname = __pathDirname\(__filename\);/g)
      ).toHaveLength(1);
    }
  );
});
