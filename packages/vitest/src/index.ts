import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseBuilder, createBaseBuilderConfig } from '@workflow/builders';
import type { Run } from '@workflow/core/runtime';
import { setWorld } from '@workflow/core/runtime';
import { workflowTransformPlugin } from '@workflow/rollup';
import type { Event, Hook } from '@workflow/world';
import { createLocalWorld, type LocalWorld } from '@workflow/world-local';
import type { Plugin } from 'vite';

class VitestBuilder extends BaseBuilder {
  #outDir: string;

  constructor(workingDir: string, outDir: string) {
    super({
      ...createBaseBuilderConfig({
        workingDir,
        dirs: ['.'],
      }),
      // 'next' target produces ESM bundles with Node.js-compatible output,
      // which is what we need for in-process vitest execution.
      buildTarget: 'next',
      suppressCreateWorkflowsBundleLogs: true,
      suppressCreateWebhookBundleLogs: true,
      suppressCreateManifestLogs: true,
    });
    this.#outDir = outDir;
  }

  protected override get shouldLogBaseBuilderInfo(): boolean {
    return false;
  }

  override async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    await mkdir(this.#outDir, { recursive: true });

    await this.createWorkflowsBundle({
      outfile: join(this.#outDir, 'workflows.mjs'),
      bundleFinalOutput: false,
      format: 'esm',
      inputFiles,
    });

    await this.createStepsBundle({
      outfile: join(this.#outDir, 'steps.mjs'),
      externalizeNonSteps: true,
      format: 'esm',
      inputFiles,
    });
  }
}

export interface WorkflowTestOptions {
  /**
   * The working directory of the project (where workflows/ lives).
   * Defaults to process.cwd().
   */
  cwd?: string;
}

function getOutDir(cwd: string): string {
  return join(cwd, '.workflow-vitest');
}

/**
 * Vitest plugin for workflow testing. Handles SWC transforms, bundle building,
 * and in-process handler registration automatically.
 *
 * @example
 * ```ts
 * // vitest.config.ts
 * import { workflow } from '@workflow/vitest';
 * import { defineConfig } from 'vitest/config';
 *
 * export default defineConfig({
 *   plugins: [workflow()],
 * });
 * ```
 */
export function workflow(): Plugin[] {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  return [
    workflowTransformPlugin(),
    {
      name: 'workflow:vitest',
      config() {
        return {
          test: {
            globalSetup: [join(dir, 'global-setup.js')],
            setupFiles: [join(dir, 'setup-file.js')],
          },
        } as Record<string, unknown>;
      },
    },
  ];
}

/**
 * Build workflow bundles for testing. Run this in vitest globalSetup.
 * This builds the workflow and step bundles to disk so they can be
 * imported by the test workers.
 */
export async function buildWorkflowTests(
  options?: WorkflowTestOptions
): Promise<void> {
  const cwd = options?.cwd ?? process.cwd();
  const outDir = getOutDir(cwd);
  const builder = new VitestBuilder(cwd, outDir);
  await builder.build();
}

let world: LocalWorld | undefined;

/**
 * Set up in-process handler routing for workflow tests.
 * Run this in vitest setupFiles (which executes in each test worker process).
 *
 * Imports the pre-built bundles, creates a local world with direct handlers,
 * and sets it as the global world.
 */
export async function setupWorkflowTests(
  options?: WorkflowTestOptions
): Promise<void> {
  // Clean up previous world if re-initialized (e.g. across test files)
  if (world) {
    setWorld(undefined);
    await world.close?.();
    world = undefined;
  }

  const cwd = options?.cwd ?? process.cwd();
  const outDir = getOutDir(cwd);

  const workflowsModule = await import(
    /* @vite-ignore */ join(outDir, 'workflows.mjs')
  );
  const stepsModule = await import(
    /* @vite-ignore */ join(outDir, 'steps.mjs')
  );

  const workflowHandler = workflowsModule.POST as (
    req: Request
  ) => Promise<Response>;
  const stepHandler = stepsModule.POST as (req: Request) => Promise<Response>;

  // Each vitest worker gets its own data directory to avoid race conditions
  const poolId = process.env.VITEST_POOL_ID ?? '0';
  world = createLocalWorld({ dataDir: join(outDir, 'data', poolId) });
  await world.start?.();
  await world.clear();

  world.registerHandler('__wkf_workflow_', workflowHandler);
  world.registerHandler('__wkf_step_', stepHandler);

  setWorld(world);
}

/**
 * Tear down the workflow test world. Call this in afterAll or vitest teardown.
 */
export async function teardownWorkflowTests(): Promise<void> {
  setWorld(undefined);
  await world?.close?.();
  world = undefined;
}

export interface WaitOptions {
  /** Maximum time to wait in milliseconds. Defaults to 30000. */
  timeout?: number;
  /** Polling interval in milliseconds. Defaults to 100. */
  pollInterval?: number;
}

function getWorldOrThrow(): LocalWorld {
  if (!world) {
    throw new Error(
      'Workflow test world is not initialized. Call setupWorkflowTests() first.'
    );
  }
  return world;
}

async function fetchAllEvents(w: LocalWorld, runId: string): Promise<Event[]> {
  const allEvents: Event[] = [];
  let cursor: string | null = null;
  do {
    const result = await w.events.list({
      runId,
      pagination: { limit: 1000, ...(cursor ? { cursor } : {}) },
      resolveData: 'none',
    });
    allEvents.push(...result.data);
    cursor = result.hasMore ? result.cursor : null;
  } while (cursor);
  return allEvents;
}

/**
 * Wait until the workflow has a pending `sleep()` call.
 *
 * Polls the event log for a `wait_created` event without a corresponding
 * `wait_completed` event. Returns the correlation ID of the pending sleep,
 * which can be passed to `run.wakeUp({ correlationIds: [id] })` to target
 * a specific sleep call.
 *
 * @returns The correlation ID of the first pending sleep.
 *
 * @example
 * ```ts
 * const run = await start(myWorkflow, []);
 * const sleepId = await waitForSleep(run);
 * await run.wakeUp({ correlationIds: [sleepId] });
 * const result = await run.returnValue;
 * ```
 */
export async function waitForSleep(
  run: Run<any>,
  options?: WaitOptions
): Promise<string> {
  const w = getWorldOrThrow();
  const timeout = options?.timeout ?? 30_000;
  const pollInterval = options?.pollInterval ?? 100;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const events = await fetchAllEvents(w, run.runId);

    const waitCompletedIds = new Set(
      events
        .filter((e) => e.eventType === 'wait_completed')
        .map((e) => e.correlationId)
    );

    const pendingSleep = events.find(
      (e) =>
        e.eventType === 'wait_created' && !waitCompletedIds.has(e.correlationId)
    );

    if (pendingSleep?.correlationId) return pendingSleep.correlationId;

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `waitForSleep timed out after ${timeout}ms: no pending sleep found for run ${run.runId}`
  );
}

/**
 * Wait until the workflow has created a hook that hasn't been received yet.
 *
 * Polls the hook list and event log for a hook matching the optional `token`
 * filter that hasn't had a `hook_received` event. Returns the matching hook,
 * which you can then resume with `resumeHook(hook.token, data)`.
 *
 * @example
 * ```ts
 * const run = await start(myWorkflow, ["doc-1"]);
 * const hook = await waitForHook(run);
 * await resumeHook(hook.token, { approved: true });
 * const result = await run.returnValue;
 * ```
 */
export async function waitForHook(
  run: Run<any>,
  options?: WaitOptions & { token?: string }
): Promise<Hook> {
  const w = getWorldOrThrow();
  const timeout = options?.timeout ?? 30_000;
  const pollInterval = options?.pollInterval ?? 100;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const [hooks, events] = await Promise.all([
      w.hooks.list({ runId: run.runId }).then((r) => r.data),
      fetchAllEvents(w, run.runId),
    ]);

    const receivedCorrelationIds = new Set(
      events
        .filter((e) => e.eventType === 'hook_received')
        .map((e) => e.correlationId)
    );

    const pendingHook = hooks.find(
      (h) =>
        !receivedCorrelationIds.has(h.hookId) &&
        (!options?.token || h.token === options.token)
    );

    if (pendingHook) return pendingHook;

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `waitForHook timed out after ${timeout}ms: no pending hook found for run ${run.runId}${options?.token ? ` with token "${options.token}"` : ''}`
  );
}
