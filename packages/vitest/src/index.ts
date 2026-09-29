import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BaseBuilder, createBaseBuilderConfig } from '@workflow/builders';
import type { Run } from '@workflow/core/runtime';
import { setWorld } from '@workflow/core/runtime';
import { workflowTransformPlugin } from '@workflow/rollup';
import type { Event, Hook } from '@workflow/world';
import {
  createWorld,
  initDataDir,
  type LocalWorld,
} from '@workflow/world-local';
import type { Plugin } from 'vite';
import type { VitestPluginContext } from 'vitest/node';
import {
  getActiveWorkflowTestOptions,
  resolveWorkflowTestOptions,
  setActiveWorkflowTestOptions,
  WORKFLOW_VITEST_OPTIONS_KEY,
} from './options.js';
import { checkWorkflowVersionSkew } from './version-check.js';
import {
  readWorkflowRefs,
  selectWorkflowRef,
  type WorkflowRef,
} from './workflow-refs.js';

export type { WorkflowRef } from './workflow-refs.js';

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

  override async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    await mkdir(this.#outDir, { recursive: true });

    const flowOutfile = join(this.#outDir, 'combined.mjs');

    // V2: Build combined bundle that includes both step registrations
    // and workflow entrypoint in a single handler.
    const result = await this.createCombinedBundle({
      inputFiles,
      stepsOutfile: join(this.#outDir, '__step_registrations.mjs'),
      flowOutfile,
      format: 'esm',
      bundleFinalOutput: false,
      externalizeNonSteps: true,
      // The generated bundles are imported directly by Node in the vitest
      // worker (no downstream bundler), so project-local imports must be
      // bundled inline. Externalizing them emits raw `.ts` specifiers that
      // Node's native ESM loader can only handle with erasable-syntax-only
      // type stripping (and not at all on older Node versions).
      bundleTransitiveLocalStepDependencies: true,
      shardWorkflowBundles: this.shardWorkflowBundlesEnabled,
    });

    // Emit the same manifest.json every other builder writes, next to the
    // bundles. `getWorkflowRef()` reads it so tests can name a workflow
    // instead of hand-writing the compiler-generated id.
    if (result?.manifest) {
      await this.createManifest({
        workflowBundlePath: flowOutfile,
        manifestDir: this.#outDir,
        manifest: result.manifest,
      });
    }
  }
}

export interface WorkflowTestOptions {
  /**
   * The working directory of the project (where workflows/ lives).
   * Defaults to the resolved Vitest project root.
   */
  cwd?: string;
  /**
   * Root directory used for default test artifacts.
   * When set, `.workflow-data` and `.workflow-vitest` are created here unless
   * overridden explicitly with `dataDir` or `outDir`.
   */
  rootDir?: string;
  /**
   * Directory for workflow runtime data written by the test world.
   * Defaults to `<rootDir>/.workflow-data`.
   */
  dataDir?: string;
  /**
   * Directory for generated workflow and step bundles.
   * Defaults to `<rootDir>/.workflow-vitest`.
   */
  outDir?: string;
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
export function workflow(options?: WorkflowTestOptions): Plugin[] {
  const transformExcludes: string[] = [];
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const vitestPlugin = {
    name: 'workflow:vitest',
    config() {
      return {
        test: {
          globalSetup: [join(dir, 'global-setup.js')],
          setupFiles: [join(dir, 'setup-file.js')],
        },
      } as Record<string, unknown>;
    },
    configureVitest({ project }: VitestPluginContext) {
      const resolvedOptions = resolveWorkflowTestOptions(
        options,
        project.config.root
      );
      transformExcludes.push(`${resolvedOptions.outDir}/`);
      project.provide(WORKFLOW_VITEST_OPTIONS_KEY, resolvedOptions);
    },
  };

  return [
    workflowTransformPlugin({
      exclude: transformExcludes,
    }),
    vitestPlugin,
  ];
}

/**
 * Build workflow bundles for testing. Run this in vitest globalSetup.
 * This builds the workflow and step bundles to disk so they can be
 * imported by the test workers.
 *
 * Also checks that `@workflow/vitest` and the app under test agree on a
 * Workflow SDK version. globalSetup runs once per Vitest run, so the report
 * is produced once rather than once per worker.
 */
export async function buildWorkflowTests(
  options?: WorkflowTestOptions
): Promise<void> {
  const resolved = resolveWorkflowTestOptions(options, process.cwd());
  const { cwd, dataDir, outDir } = resolved;
  setActiveWorkflowTestOptions(resolved);
  checkWorkflowVersionSkew({ cwd });
  const builder = new VitestBuilder(cwd, outDir);
  await builder.build();
  // Pre-create the shared data directory so workers don't race on mkdir
  await initDataDir(dataDir);
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

  const resolved = resolveWorkflowTestOptions(options, process.cwd());
  const { dataDir, outDir } = resolved;
  setActiveWorkflowTestOptions(resolved);

  // Lazy-load bundles on first dispatch instead of eagerly at setup time.
  // Eager native import() during setupFiles loads step dependencies into
  // the module cache before vi.mock() can intercept them, breaking mocks
  // in unit tests that never execute workflows.
  function createLazyHandler(
    bundlePath: string
  ): (req: Request) => Promise<Response> {
    let handler: ((req: Request) => Promise<Response>) | undefined;
    let loading: Promise<(req: Request) => Promise<Response>> | undefined;

    return async (req: Request) => {
      if (!handler) {
        // If the import rejects (e.g. missing bundle), the rejected promise is
        // cached so all subsequent calls fail fast with the same error.
        loading ??= import(
          /* @vite-ignore */ pathToFileURL(bundlePath).href
        ).then((mod) => mod.POST as (req: Request) => Promise<Response>);
        handler = await loading;
      }
      return handler(req);
    };
  }

  // Each vitest worker uses a unique tag to isolate its test data.
  // All workers write to the shared .workflow-data directory so runs
  // are visible to the observability dashboard, but clear() only
  // deletes files matching the worker's tag. Recovery stays disabled because
  // tests expect a clean world and register direct handlers after setup begins.
  const poolId = process.env.VITEST_POOL_ID ?? '0';
  world = createWorld({
    dataDir,
    recoverActiveRuns: false,
    tag: `vitest-${poolId}`,
  });
  await world.clear();

  // V2: Single combined handler for both workflow and step execution.
  world.registerHandler(
    '__wkf_workflow_',
    createLazyHandler(join(outDir, 'combined.mjs'))
  );

  // Handlers must be registered before start(): if recoverActiveRuns is ever
  // re-enabled here (or plumbed through from a caller), start() re-enqueues
  // pending runs and the queue begins dispatching. Registering after start
  // would race handler installation against that dispatch.
  await world.start?.();
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

/**
 * Every workflow the test build compiled, read from the manifest written next
 * to the test bundles.
 *
 * Useful for asserting on what a build produced, and for building error
 * messages when a lookup misses.
 *
 * @example
 * ```ts
 * expect(listWorkflowRefs().map((ref) => ref.name)).toContain("approvalWorkflow");
 * ```
 */
export function listWorkflowRefs(): WorkflowRef[] {
  return readWorkflowRefs(getActiveWorkflowTestOptions().outDir);
}

/**
 * Look up a workflow in the test build by name, in the shape `start()` takes.
 *
 * Importing the workflow function is still the better option when a test can
 * do it, because it keeps the argument and return types. Use this when it
 * cannot: the workflow lives in a module the test does not import, or the test
 * drives runs by name. Either way it beats hand-writing the generated id.
 *
 * `query` is an exported workflow name (`"approvalWorkflow"`), or a
 * file-qualified name when one name appears in several files
 * (`"workflows/approval.ts#approvalWorkflow"`, matched by path suffix).
 *
 * @throws If the manifest is missing, nothing matches, or the name is
 * ambiguous. The error lists the workflows the build does contain.
 *
 * @example
 * ```ts
 * const run = await start(getWorkflowRef("approvalWorkflow"), ["doc-1"]);
 * ```
 */
export function getWorkflowRef(query: string): WorkflowRef {
  return selectWorkflowRef(listWorkflowRefs(), query);
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
 * Pass `notHookId` to explicitly exclude a previously observed hook when a
 * workflow creates several hooks with the same token.
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
  options?: WaitOptions & { token?: string; notHookId?: string }
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
        (!options?.token || h.token === options.token) &&
        // Skip a hook the caller explicitly excluded.
        (!options?.notHookId || h.hookId !== options.notHookId)
    );

    if (pendingHook) return pendingHook;

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `waitForHook timed out after ${timeout}ms: no pending hook found for run ${run.runId}${options?.token ? ` with token "${options.token}"` : ''}${options?.notHookId ? ` other than "${options.notHookId}"` : ''}`
  );
}
