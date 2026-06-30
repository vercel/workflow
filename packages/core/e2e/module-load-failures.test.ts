import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkflowRunFailedError } from '@workflow/errors';
import { getQueueTopicPrefix } from '@workflow/world';
import { afterEach, assert, describe, expect, test } from 'vitest';
import type { WorkflowManifest } from '../../builders/src/apply-swc-transform';
import { BaseBuilder } from '../../builders/src/base-builder';
import type { StandaloneConfig } from '../../builders/src/types';
import { createLocalWorld, type LocalWorld } from '../../world-local/src';
import {
  registerStepFunctionLoader,
  setWorld,
  start,
  workflowEntrypoint,
} from '../src/runtime';

const sharpLoadError =
  'Could not load the "sharp" module using the linux-x64 runtime';

class E2EBuilder extends BaseBuilder {
  async build(): Promise<void> {
    // The tests call the protected bundle helper directly.
  }

  createCombinedRoute({
    inputFiles,
    stepsOutfile,
    flowOutfile,
  }: {
    inputFiles: string[];
    stepsOutfile: string;
    flowOutfile: string;
  }) {
    return this.createCombinedBundle({
      inputFiles,
      stepsOutfile,
      flowOutfile,
      bundleFinalOutput: false,
      externalizeNonSteps: true,
      sourceStepRegistrationImports: true,
    });
  }
}

function createBuilder(workingDir: string): E2EBuilder {
  const config: StandaloneConfig = {
    buildTarget: 'standalone',
    workingDir,
    dirs: ['.'],
    stepsBundlePath: join(workingDir, '.workflow', '__step_registrations.js'),
    workflowsBundlePath: join(workingDir, '.workflow', 'flow.js'),
    webhookBundlePath: join(workingDir, '.workflow', 'webhook.js'),
  };
  return new E2EBuilder(config);
}

async function writeFileWithParents(filePath: string, contents: string) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

function findManifestEntry(
  entries: WorkflowManifest['workflows'] | WorkflowManifest['steps'],
  fnName: string
): { workflowId?: string; stepId?: string } {
  for (const functions of Object.values(entries ?? {})) {
    const entry = functions[fnName];
    if (entry) return entry;
  }
  throw new Error(`Could not find ${fnName} in generated manifest`);
}

async function installWorkflowRuntimePackage(testRoot: string) {
  const packageRoot = join(testRoot, 'node_modules', 'workflow');
  await writeFileWithParents(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: 'workflow',
      type: 'module',
      exports: {
        './runtime': './runtime.js',
        './internal/builtins': './internal/builtins.js',
      },
    })
  );
  await writeFileWithParents(
    join(packageRoot, 'runtime.js'),
    `const runtime = globalThis.__workflowModuleLoadFailureE2ERuntime;
if (!runtime) {
  throw new Error('Missing workflow module load failure e2e runtime');
}
export const registerStepFunctionLoader = runtime.registerStepFunctionLoader;
export const workflowEntrypoint = runtime.workflowEntrypoint;
`
  );
  await writeFileWithParents(
    join(packageRoot, 'internal', 'builtins.js'),
    `export const __workflow_e2e_builtins = true;
`
  );
}

async function setupGeneratedRoute({
  files,
  inputFileNames,
}: {
  files: Record<string, string>;
  inputFileNames: string[];
}): Promise<{
  testRoot: string;
  world: LocalWorld;
  manifest: WorkflowManifest;
}> {
  const testRoot = await mkdtemp(join(tmpdir(), 'workflow-module-load-e2e-'));
  await installWorkflowRuntimePackage(testRoot);

  for (const [fileName, contents] of Object.entries(files)) {
    await writeFileWithParents(join(testRoot, fileName), contents);
  }

  const builder = createBuilder(testRoot);
  const routeDir = join(testRoot, '.workflow');
  const stepsOutfile = join(routeDir, '__step_registrations.js');
  const flowOutfile = join(routeDir, 'flow.js');
  await mkdir(routeDir, { recursive: true });
  const { manifest } = await builder.createCombinedRoute({
    inputFiles: inputFileNames.map((fileName) => join(testRoot, fileName)),
    stepsOutfile,
    flowOutfile,
  });

  (
    globalThis as typeof globalThis & {
      __workflowModuleLoadFailureE2ERuntime?: {
        registerStepFunctionLoader: typeof registerStepFunctionLoader;
        workflowEntrypoint: typeof workflowEntrypoint;
      };
    }
  ).__workflowModuleLoadFailureE2ERuntime = {
    registerStepFunctionLoader,
    workflowEntrypoint,
  };
  const routeModule = (await import(
    `${pathToFileURL(flowOutfile).href}?t=${Date.now()}`
  )) as { POST: (request: Request) => Promise<Response> };

  const world = createLocalWorld({
    dataDir: join(testRoot, '.workflow-data'),
    recoverActiveRuns: false,
  });
  await world.start();
  world.registerHandler(getQueueTopicPrefix('workflow'), routeModule.POST);
  setWorld(world);

  return { testRoot, world, manifest };
}

describe('module load failures e2e', () => {
  const cleanup: Array<{ testRoot: string; world: LocalWorld }> = [];

  afterEach(async () => {
    setWorld(undefined);
    delete (
      globalThis as typeof globalThis & {
        __workflowModuleLoadFailureE2ERuntime?: unknown;
      }
    ).__workflowModuleLoadFailureE2ERuntime;
    await Promise.all(
      cleanup.splice(0).map(async ({ testRoot, world }) => {
        await world.close();
        await rm(testRoot, { recursive: true, force: true });
      })
    );
  });

  test('step registration module load failure is recorded as step_failed', async () => {
    const stepId = 'step//./workflows/step-load-failure//brokenStep';
    const fixture = await setupGeneratedRoute({
      files: {
        'workflows/step-load-failure.js': `import './sharp-load-failure.js';

export async function brokenStep() {
  'use step';
  return 'unreachable';
}
`,
        'workflows/sharp-load-failure.js': `throw new Error(${JSON.stringify(
          sharpLoadError
        )});
`,
        'workflows/step-load-failure-workflow.js': `export async function stepModuleLoadFailureWorkflow() {
  'use workflow';
  const brokenStep = globalThis[Symbol.for('WORKFLOW_USE_STEP')](${JSON.stringify(
    stepId
  )});
  try {
    await brokenStep();
    return { caught: false };
  } catch (error) {
    return {
      caught: true,
      message: error?.message,
      name: error?.name,
      causeMessage: error?.cause?.message,
    };
  }
}
`,
      },
      inputFileNames: [
        'workflows/step-load-failure.js',
        'workflows/step-load-failure-workflow.js',
      ],
    });
    cleanup.push(fixture);

    expect(findManifestEntry(fixture.manifest.steps, 'brokenStep').stepId).toBe(
      stepId
    );
    const workflowId = findManifestEntry(
      fixture.manifest.workflows,
      'stepModuleLoadFailureWorkflow'
    ).workflowId;
    assert(workflowId);

    const run = await start<
      [],
      {
        caught: boolean;
        message?: string;
        name?: string;
        causeMessage?: string;
      }
    >({ workflowId }, [], { world: fixture.world });
    const result = await run.returnValue;

    expect(result.caught).toBe(true);
    expect(result.name).toBe('FatalError');
    expect(result.message).toContain(sharpLoadError);
    expect(result.causeMessage).toContain(sharpLoadError);

    const events = await fixture.world.events.list({
      runId: run.runId,
      resolveData: 'none',
      pagination: { limit: 100, sortOrder: 'asc' },
    });
    expect(events.data.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['step_started', 'step_failed', 'run_completed'])
    );
    const stepStartedIndex = events.data.findIndex(
      (event) => event.eventType === 'step_started'
    );
    const stepFailedIndex = events.data.findIndex(
      (event) => event.eventType === 'step_failed'
    );
    expect(stepStartedIndex).toBeGreaterThanOrEqual(0);
    expect(stepFailedIndex).toBeGreaterThan(stepStartedIndex);
  });

  test('workflow bundle evaluation failure is recorded as run_failed', async () => {
    const fixture = await setupGeneratedRoute({
      files: {
        'workflows/workflow-load-failure.js': `throw new Error(${JSON.stringify(
          sharpLoadError
        )});

export async function workflowModuleLoadFailureWorkflow() {
  'use workflow';
  return 'unreachable';
}
`,
      },
      inputFileNames: ['workflows/workflow-load-failure.js'],
    });
    cleanup.push(fixture);

    const workflowId = findManifestEntry(
      fixture.manifest.workflows,
      'workflowModuleLoadFailureWorkflow'
    ).workflowId;
    assert(workflowId);

    const run = await start({ workflowId }, [], { world: fixture.world });
    const error = await run.returnValue.catch((err: unknown) => err);

    expect(WorkflowRunFailedError.is(error)).toBe(true);
    assert(WorkflowRunFailedError.is(error));
    expect(error.errorCode).toBe('USER_ERROR');
    assert(error.cause instanceof Error);
    expect(error.cause.message).toContain(sharpLoadError);

    const events = await fixture.world.events.list({
      runId: run.runId,
      resolveData: 'none',
      pagination: { limit: 100, sortOrder: 'asc' },
    });
    expect(events.data.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['run_started', 'run_failed'])
    );
  });
});
