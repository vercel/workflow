import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BaseBuilder, createBaseBuilderConfig } from '@workflow/builders';
import type { Run } from '@workflow/core/runtime';
import { setWorld } from '@workflow/core/runtime';
import { getWorkflowQueueName } from '@workflow/core/runtime/helpers';
import { workflowTransformPlugin } from '@workflow/rollup';
import {
  type Event,
  type Hook,
  ValidQueueName,
  type World,
} from '@workflow/world';
import {
  createWorld,
  initDataDir,
  type LocalWorld,
} from '@workflow/world-local';
import type { SqliteWorld } from '@workflow/world-sqlite';
import type { Plugin } from 'vite';
import type { VitestPluginContext } from 'vitest/node';
import {
  resolveWorkflowTestOptions,
  WORKFLOW_VITEST_OPTIONS_KEY,
} from './options.js';

const HOST_MANIFEST_FILENAME = 'host.json';
const SQLITE_POOL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

interface WorkflowTestHostManifest {
  queueNames: string[];
}

class VitestBuilder extends BaseBuilder {
  #outDir: string;
  #queueNames: string[] = [];

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

    // V2: Build combined bundle that includes both step registrations
    // and workflow entrypoint in a single handler.
    const { manifest } = await this.createCombinedBundle({
      inputFiles,
      stepsOutfile: join(this.#outDir, '__step_registrations.mjs'),
      flowOutfile: join(this.#outDir, 'combined.mjs'),
      format: 'esm',
      bundleFinalOutput: false,
      externalizeNonSteps: true,
      // The generated bundles are imported directly by Node in the vitest
      // worker (no downstream bundler), so project-local imports must be
      // bundled inline. Externalizing them emits raw `.ts` specifiers that
      // Node's native ESM loader can only handle with erasable-syntax-only
      // type stripping (and not at all on older Node versions).
      bundleTransitiveLocalStepDependencies: true,
    });

    this.#queueNames = [
      ...new Set(
        Object.values(manifest.workflows ?? {})
          .flatMap((workflows) => Object.values(workflows))
          .map(({ workflowId }) =>
            getWorkflowQueueName(
              workflowId,
              process.env.WORKFLOW_QUEUE_NAMESPACE
            )
          )
      ),
    ].sort();
  }

  get queueNames(): readonly string[] {
    return this.#queueNames;
  }
}

export interface WorkflowTestOptions {
  /**
   * World implementation used by the test workers. Defaults to `local`.
   * SQLite is experimental and must be selected explicitly.
   */
  world?: 'local' | 'sqlite';
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
   * Directory for SQLite test databases. Each Vitest pool gets a separate
   * `vitest-<pool>.sqlite` file. Defaults to
   * `WORKFLOW_LOCAL_DATABASE_DIR`, then `<rootDir>/.workflow-database`.
   */
  databaseDir?: string;
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
 */
export async function buildWorkflowTests(
  options?: WorkflowTestOptions
): Promise<void> {
  const { cwd, world, dataDir, databaseDir, outDir } =
    resolveWorkflowTestOptions(options, process.cwd());
  const builder = new VitestBuilder(cwd, outDir);
  await builder.build();
  await writeFile(
    join(outDir, HOST_MANIFEST_FILENAME),
    `${JSON.stringify({ queueNames: builder.queueNames }, null, 2)}\n`
  );

  if (world === 'sqlite') {
    // Pre-create the shared parent so workers only create their own database
    // file and SQLite-owned WAL sidecars beneath it.
    await mkdir(databaseDir, { recursive: true });
  } else {
    // Pre-create the shared data directory so workers don't race on mkdir.
    await initDataDir(dataDir);
  }
}

type WorkflowTestWorld = LocalWorld | SqliteWorld;

let world: WorkflowTestWorld | undefined;
let loopbackServer: Server | undefined;

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

async function readRequestBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(
      typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk)
    );
  }
  return Buffer.concat(chunks);
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function startLoopbackServer(
  handler: (request: Request) => Promise<Response>
): Promise<{ server: Server; flowUrl: string }> {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const method = incoming.method ?? 'POST';
      const body =
        method === 'GET' || method === 'HEAD'
          ? undefined
          : await readRequestBody(incoming);
      const request = new Request(
        `http://${incoming.headers.host ?? '127.0.0.1'}${incoming.url ?? '/'}`,
        {
          method,
          headers: requestHeaders(incoming),
          ...(body !== undefined && { body }),
        }
      );
      const response = await handler(request);
      outgoing.statusCode = response.status;
      for (const [name, value] of response.headers) {
        outgoing.setHeader(name, value);
      }
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.statusCode = 500;
      outgoing.end(String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address() as AddressInfo;
  return {
    server,
    flowUrl: `http://127.0.0.1:${address.port}/.well-known/workflow/v1/flow`,
  };
}

async function closeLoopbackServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

function sqlitePoolId(): string {
  const poolId = process.env.VITEST_POOL_ID ?? '0';
  if (!SQLITE_POOL_ID_PATTERN.test(poolId)) {
    throw new Error(
      `Invalid VITEST_POOL_ID ${JSON.stringify(poolId)}: expected 1-64 alphanumeric, underscore, or hyphen characters`
    );
  }
  return poolId;
}

async function readHostManifest(
  outDir: string
): Promise<WorkflowTestHostManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(join(outDir, HOST_MANIFEST_FILENAME), 'utf8')
    );
  } catch (cause) {
    throw new Error(
      'Workflow test host manifest is missing or invalid. Run buildWorkflowTests() before setupWorkflowTests().',
      { cause }
    );
  }
  const queueNames = (parsed as { queueNames?: unknown })?.queueNames;
  if (!Array.isArray(queueNames)) {
    throw new Error('Workflow test host manifest has invalid queueNames');
  }
  return {
    queueNames: [
      ...new Set(queueNames.map((name) => ValidQueueName.parse(name))),
    ],
  };
}

async function resetWorkflowTestWorld(): Promise<void> {
  setWorld(undefined);
  const currentWorld = world;
  const currentServer = loopbackServer;
  world = undefined;
  loopbackServer = undefined;
  try {
    await currentWorld?.close?.();
  } finally {
    await closeLoopbackServer(currentServer);
  }
}

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
  if (world || loopbackServer) await resetWorkflowTestWorld();

  const resolvedOptions = resolveWorkflowTestOptions(options, process.cwd());
  const { dataDir, databaseDir, outDir } = resolvedOptions;
  const handler = createLazyHandler(join(outDir, 'combined.mjs'));

  try {
    if (resolvedOptions.world === 'sqlite') {
      const [{ createWorld: createSqliteWorld }, host] = await Promise.all([
        import('@workflow/world-sqlite'),
        readHostManifest(outDir),
      ]);
      const poolId = sqlitePoolId();
      await mkdir(databaseDir, { recursive: true });
      const loopback = await startLoopbackServer(handler);
      loopbackServer = loopback.server;
      world = createSqliteWorld({
        databaseFile: join(databaseDir, `vitest-${poolId}.sqlite`),
        queueNames: host.queueNames,
        flowUrl: loopback.flowUrl,
        recoverActiveRuns: false,
      });
      // Migrations are explicit: setup never relies on construction or the
      // first operation to mutate the database schema.
      await world.migrate();
      await world.clear();
    } else {
      // Each filesystem-world worker uses a unique tag to isolate its test
      // data. Preserve the legacy overlay behavior while SQLite coexists.
      const poolId = process.env.VITEST_POOL_ID ?? '0';
      world = createWorld({
        dataDir,
        recoverActiveRuns: false,
        tag: `vitest-${poolId}`,
      });
      await world.clear();

      // The filesystem World supports direct callbacks. SQLite deliberately
      // uses the private loopback server above instead.
      world.registerHandler('__wkf_workflow_', handler);
    }

    // Routing is installed before start(): even with recovery disabled, this
    // keeps future recovery changes from racing worker activation.
    await world.start?.();
    setWorld(world);
  } catch (error) {
    await resetWorkflowTestWorld().catch(() => undefined);
    throw error;
  }
}

/**
 * Tear down the workflow test world. Call this in afterAll or vitest teardown.
 */
export async function teardownWorkflowTests(): Promise<void> {
  await resetWorkflowTestWorld();
}

export interface WaitOptions {
  /** Maximum time to wait in milliseconds. Defaults to 30000. */
  timeout?: number;
  /** Polling interval in milliseconds. Defaults to 100. */
  pollInterval?: number;
}

function getWorldOrThrow(): World {
  if (!world) {
    throw new Error(
      'Workflow test world is not initialized. Call setupWorkflowTests() first.'
    );
  }
  return world;
}

async function fetchAllEvents(w: World, runId: string): Promise<Event[]> {
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
