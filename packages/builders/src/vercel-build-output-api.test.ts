import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredEntries } from './base-builder.js';
import { ALLOW_UNREGISTERED_STEPS_ENV } from './step-registration-check.js';
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

function createConfig(workingDir: string): VercelBuildOutputConfig {
  return {
    buildTarget: 'vercel-build-output-api',
    workingDir,
    dirs: ['src'],
    stepsBundlePath: join(workingDir, 'unused-steps.mjs'),
    workflowsBundlePath: join(workingDir, 'unused-workflows.mjs'),
    webhookBundlePath: join(workingDir, 'unused-webhook.mjs'),
    suppressCreateManifestLogs: true,
  };
}

function createBuilder(workingDir: string): VercelBuildOutputAPIBuilder {
  return new VercelBuildOutputAPIBuilder(createConfig(workingDir));
}

/**
 * Stands in for a discovery miss: the builder behaves normally except that
 * the step file ending in `skippedStepFile` (a path relative to the project,
 * with forward slashes) is never reported as a step file, which is what
 * happened to a step whose `"use step"` shared a line with its body.
 */
class StepDiscoveryMissBuilder extends VercelBuildOutputAPIBuilder {
  /** Contexts handed back by the two bundles, to check they get disposed. */
  readonly contexts: { dispose: ReturnType<typeof vi.fn> }[] = [];

  constructor(
    workingDir: string,
    private readonly skippedStepFile: string,
    private readonly options: { watch?: boolean; rejectDispose?: boolean } = {}
  ) {
    super({ ...createConfig(workingDir), watch: options.watch });
  }

  protected override async discoverEntries(
    inputs: string[],
    outdir: string,
    tsconfigPath?: string
  ): Promise<DiscoveredEntries> {
    const discovered = await super.discoverEntries(
      inputs,
      outdir,
      tsconfigPath
    );
    const skipped = [...discovered.discoveredSteps].filter((file) =>
      file.replace(/\\/g, '/').endsWith(`/${this.skippedStepFile}`)
    );
    // Without this, a path that does not match (backslashes on Windows, for
    // one) turns the miss into a normal build and the test into a no-op.
    if (skipped.length !== 1) {
      throw new Error(
        `Expected to skip one step file ending in ${this.skippedStepFile}, found ${JSON.stringify([...discovered.discoveredSteps])}`
      );
    }
    discovered.discoveredSteps.delete(skipped[0]);
    return discovered;
  }

  /** Calls createCombinedBundle() directly, the way watch-mode builders do. */
  async combine() {
    return this.createCombinedBundle({
      inputFiles: await this.getInputFiles(),
      stepsOutfile: join(this.config.workingDir, '.out/steps.mjs'),
      flowOutfile: join(this.config.workingDir, '.out/flow.mjs'),
      bundleFinalOutput: false,
    });
  }

  private track<T extends { dispose: () => Promise<void> } | undefined>(
    context: T
  ): T {
    if (!context) return context;
    const dispose = context.dispose.bind(context);
    const spy = vi.fn(async () => {
      await dispose();
      if (this.options.rejectDispose) throw new Error('dispose failed');
    });
    context.dispose = spy;
    this.contexts.push({ dispose: spy });
    return context;
  }

  protected override async createStepsBundle(
    args: Parameters<VercelBuildOutputAPIBuilder['createStepsBundle']>[0]
  ) {
    const result = await super.createStepsBundle(args);
    this.track(result.context);
    return result;
  }

  protected override async createWorkflowsBundle(
    args: Parameters<VercelBuildOutputAPIBuilder['createWorkflowsBundle']>[0]
  ) {
    const result = await super.createWorkflowsBundle(args);
    this.track(result.interimBundleCtx);
    return result;
  }
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
const steps = globalThis[Symbol.for('@workflow/core//registeredSteps')];
const step = [...(steps ?? [])].find(([id]) => id.endsWith(${JSON.stringify(`//${stepName}`)}))?.[1];
if (!step) throw new Error(${JSON.stringify(`${stepName} step was not registered`)});
process.stdout.write(JSON.stringify(await step()));`,
    ],
    // Piped so a failing step's stderr lands in the thrown error's message
    // instead of the test log.
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
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
    'export function workflowEntrypoint() { return async function POST() { return new Response(null, { status: 204 }); }; }\n'
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

describe('VercelBuildOutputAPIBuilder step discovery', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(realpathSync(tmpdir()), 'workflow-vercel-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it(
    'registers steps whose "use step" shares a line with other code',
    { timeout: BUILD_TIMEOUT },
    async () => {
      await writeWorkflowRuntimeStub(workingDir);
      // A step in the workflow's own file, and one in a file that only has
      // one-line steps, so discovery has to find it from the directive alone.
      await write(
        join(workingDir, 'src/workflows/inline.ts'),
        `import { fromOtherFile } from '../lib/helpers';

export async function doWork() { "use step"; return 'same-file'; }

export async function inlineWorkflow() {
  'use workflow';
  return [await doWork(), await fromOtherFile()];
}
`
      );
      await write(
        join(workingDir, 'src/lib/helpers.ts'),
        `export const fromOtherFile = async () => { 'use step'; return 'other-file'; };
`
      );

      await createBuilder(workingDir).build();

      expect(executeStep(workingDir, 'doWork')).toBe('same-file');
      expect(executeStep(workingDir, 'fromOtherFile')).toBe('other-file');

      const manifest = JSON.parse(
        await readFile(
          join(
            workingDir,
            '.vercel/output/diagnostics/workflows-manifest.json'
          ),
          'utf8'
        )
      );
      expect(Object.keys(manifest.steps).sort()).toEqual([
        'src/lib/helpers.ts',
        'src/workflows/inline.ts',
      ]);
    }
  );
});

describe('VercelBuildOutputAPIBuilder SDK steps', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(realpathSync(tmpdir()), 'workflow-vercel-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it(
    "registers Run's steps when the project can resolve workflow but not @workflow/core",
    { timeout: BUILD_TIMEOUT },
    async () => {
      // The project depends on `workflow` alone, the way pnpm installs it:
      // `@workflow/core` is reachable from `workflow`, not from the project.
      // The workflow bundle reaches `Run`'s steps through `workflow`'s
      // `workflow` export condition, so the steps bundle has to as well.
      //
      // The `workflow` package here is a stand-in whose `workflow` condition
      // re-exports `@workflow/core/_workflow`, as the real one does, over the
      // real `@workflow/core`. Linking `packages/workflow` itself would need
      // its `dist/`, which the unit test job does not build: `workflow`
      // depends on `@workflow/builders` (through `@workflow/cli`, `@workflow/next`
      // and others), so `@workflow/builders` cannot depend on it.
      const workflowPackage = join(workingDir, 'node_modules/workflow');
      await write(
        join(workflowPackage, 'package.json'),
        JSON.stringify({
          name: 'workflow',
          version: '1.0.0',
          type: 'module',
          exports: {
            '.': { workflow: './workflow.js', default: './index.js' },
            './api': './api.js',
            './internal/builtins': './internal/builtins.js',
            './runtime': './runtime.js',
          },
        })
      );
      await write(
        join(workflowPackage, 'workflow.js'),
        "export * from '@workflow/core/_workflow';\n"
      );
      await write(
        join(workflowPackage, 'index.js'),
        "export * from '@workflow/core';\n"
      );
      await write(
        join(workflowPackage, 'internal/builtins.js'),
        'export const __workflow_builtins = true;\n'
      );
      for (const entry of ['api.js', 'runtime.js']) {
        await write(
          join(workflowPackage, entry),
          "export * from '@workflow/core/runtime';\n"
        );
      }
      await mkdir(join(workflowPackage, 'node_modules/@workflow'), {
        recursive: true,
      });
      symlinkSync(
        realpathSync(join(import.meta.dirname, '../../core')),
        join(workflowPackage, 'node_modules/@workflow/core'),
        'junction'
      );
      await write(
        join(workingDir, 'src/workflows/hello.ts'),
        `import { sleep } from 'workflow';

export async function helloWorkflow() {
  'use workflow';
  await sleep('1s');
  return 'done';
}
`
      );

      await createBuilder(workingDir).build();

      const registered = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `await import(${JSON.stringify(
              pathToFileURL(join(getFlowFuncDir(workingDir), 'index.mjs')).href
            )});
const steps = globalThis[Symbol.for('@workflow/core//registeredSteps')];
process.stdout.write(JSON.stringify([...(steps?.keys() ?? [])]));`,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        )
      ) as string[];
      expect(registered.some((id) => id.endsWith('//Run#status'))).toBe(true);
    }
  );
});

describe('VercelBuildOutputAPIBuilder unregistered steps', () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = mkdtempSync(join(realpathSync(tmpdir()), 'workflow-vercel-'));
    await writeWorkflowRuntimeStub(workingDir);
    await write(
      join(workingDir, 'src/workflows/order.ts'),
      `import { chargeCard } from '../lib/payments';

export async function orderWorkflow() {
  'use workflow';
  return chargeCard();
}
`
    );
    await write(
      join(workingDir, 'src/lib/payments.ts'),
      `export async function chargeCard() {
  'use step';
  return 'charged';
}
`
    );
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env[ALLOW_UNREGISTERED_STEPS_ENV];
  });

  it(
    'fails the build when a workflow can call a step the steps bundle does not register',
    { timeout: BUILD_TIMEOUT },
    async () => {
      const builder = new StepDiscoveryMissBuilder(
        workingDir,
        'src/lib/payments.ts'
      );

      const error = await builder.build().then(
        () => undefined,
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(
        'Workflow code can call 1 step that is not registered in the steps bundle.'
      );
      expect(message).toContain(
        'chargeCard in src/lib/payments.ts (step//./src/lib/payments//chargeCard)'
      );
      expect(message).toContain('"use step" is the first statement');
      expect(message).toContain(`${ALLOW_UNREGISTERED_STEPS_ENV}=1`);
    }
  );

  it.each([
    ['', false],
    [' when disposing a context fails', true],
  ])(
    'disposes both watch-mode contexts when the check fails%s',
    { timeout: BUILD_TIMEOUT },
    async (_, rejectDispose) => {
      const builder = new StepDiscoveryMissBuilder(
        workingDir,
        'src/lib/payments.ts',
        { watch: true, rejectDispose }
      );

      const error = await builder.combine().then(
        () => undefined,
        (caught: unknown) => caught
      );

      // The check's error wins over a failed dispose.
      expect((error as Error).message).toContain(
        'Workflow code can call 1 step that is not registered'
      );
      expect(builder.contexts).toHaveLength(2);
      for (const context of builder.contexts) {
        expect(context.dispose).toHaveBeenCalledOnce();
      }
    }
  );

  it(
    'builds with a warning behind the escape hatch',
    { timeout: BUILD_TIMEOUT },
    async () => {
      process.env[ALLOW_UNREGISTERED_STEPS_ENV] = '1';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await new StepDiscoveryMissBuilder(
          workingDir,
          'src/lib/payments.ts'
        ).build();

        const warnings = warnSpy.mock.calls.map(([message]) => String(message));
        expect(
          warnings.some((message) =>
            message.includes('chargeCard in src/lib/payments.ts')
          )
        ).toBe(true);
        // The warning is accurate: the deployment really lacks the step.
        expect(() => executeStep(workingDir, 'chargeCard')).toThrow(
          /chargeCard step was not registered/
        );
      } finally {
        warnSpy.mockRestore();
      }
    }
  );

  it(
    'builds without a warning when discovery finds the step',
    { timeout: BUILD_TIMEOUT },
    async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await createBuilder(workingDir).build();
        expect(
          warnSpy.mock.calls.some(([message]) =>
            String(message).includes('not registered')
          )
        ).toBe(false);
        expect(executeStep(workingDir, 'chargeCard')).toBe('charged');
      } finally {
        warnSpy.mockRestore();
      }
    }
  );
});
