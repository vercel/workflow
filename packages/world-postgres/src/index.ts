import type { Queue, Storage, World } from '@workflow/world';
import { mintedSpecVersion, reenqueueActiveRuns } from '@workflow/world';
import { Pool } from 'pg';
import type { PostgresWorldConfig } from './config.js';
import { handleConnectionErrors } from './connection-errors.js';
import { createClient, type Drizzle } from './drizzle/index.js';
import { createQueue } from './queue.js';
import { recoverQueueMessages } from './queue-payloads.js';
import { recoverRunUserData } from './retention.js';
import {
  createRunStatusListener,
  type RunStatusListener,
} from './run-status.js';
import { createSnapshotsStorage } from './snapshots.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
  recoverTerminalRequests,
} from './storage.js';
import { createStreamer } from './streamer.js';

function createStorage(
  drizzle: Drizzle,
  runStatusListener: RunStatusListener
): Storage {
  return {
    runs: createRunsStorage(drizzle, runStatusListener),
    events: createEventsStorage(drizzle),
    hooks: createHooksStorage(drizzle),
    steps: createStepsStorage(drizzle),
    experimental_snapshots: createSnapshotsStorage(drizzle),
  };
}

function getPositiveIntEnv(name: string): number | undefined {
  const parsed = parseInt(process.env[name] || '', 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getDefaultConnectionString(): string {
  return (
    process.env.WORKFLOW_POSTGRES_URL ||
    process.env.DATABASE_URL ||
    'postgres://world:world@localhost:5432/world'
  );
}

export function createWorld(
  config: PostgresWorldConfig = {
    connectionString: getDefaultConnectionString(),
    jobPrefix: process.env.WORKFLOW_POSTGRES_JOB_PREFIX,
    queueConcurrency:
      parseInt(process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY || '50', 10) ||
      50,
    pollInterval: getPositiveIntEnv('WORKFLOW_POSTGRES_POLL_INTERVAL_MS'),
    applicationManagedShutdown:
      process.env.WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN === '1',
    enableInvoke: process.env.WORKFLOW_POSTGRES_INVOKE === '1',
  }
): World &
  Required<Pick<Queue, 'registerHandler' | 'registerRoute'>> & {
    start(): Promise<void>;
  } {
  const maxPoolSize =
    config.maxPoolSize ?? getPositiveIntEnv('WORKFLOW_POSTGRES_MAX_POOL_SIZE');
  let closing = false;
  const pool =
    config.pool || createOwnedPool(config, maxPoolSize, () => closing);

  const drizzle = createClient(pool);
  // Share readiness across queue admission and inspection: restored payloads
  // stay unavailable until cleanup succeeds, including after a failed start.
  let converted: Promise<void> | undefined;
  const recoverPayloads = async () => {
    if (!converted) {
      converted = (async () => {
        await queue.prepare();
        await recoverQueueMessages(drizzle, config.jobPrefix || 'workflow_');
        await recoverRunUserData(drizzle);
      })().catch((error) => {
        converted = undefined;
        throw error;
      });
    }
    await converted;
    await recoverTerminalRequests(drizzle);
  };
  const afterRecovery = <
    Operation extends (...args: never[]) => Promise<unknown>,
  >(
    operation: Operation
  ): Operation =>
    // Forward unchanged to preserve the overloaded resolveData signatures.
    (async (...args: never[]) => {
      await recoverPayloads();
      return operation(...args);
    }) as Operation;
  const queue = createQueue(config, pool, recoverPayloads);
  // Opens its `LISTEN` connection lazily, on the first `waitForTerminalStatus`
  // call, so a deployment that never awaits a run never pays for it.
  const runStatusListener = createRunStatusListener(pool);
  const storage = createStorage(drizzle, runStatusListener);
  const streamer = createStreamer(pool, drizzle);

  return {
    specVersion: mintedSpecVersion(),
    capabilities: {
      hookRetention: { active: true },
      // Stored in the runs table's `dynamic_workflow_code_cbor` column; no
      // upload path, so `start()` always sends the code inline.
      dynamicWorkflowCode: true,
      hookResumeDedup: true,
      ...(config.enableInvoke ? { invoke: true } : {}),
      // One transaction re-points the token, journals the victim's
      // `hook_disposed{forceClaimedBy}` and creates the claimer's hook; see
      // the hook_created branch of storage.ts.
      hookForceClaim: true,
      // The events storage fences in-band writes; see storage.ts.
      inBandFence: true,
    },
    ...storage,
    ...streamer,
    ...queue,
    runs: {
      ...storage.runs,
      get: afterRecovery(storage.runs.get),
      ...(storage.runs.getMany && {
        getMany: afterRecovery(storage.runs.getMany),
      }),
      list: afterRecovery(storage.runs.list),
      ...(storage.runs.experimentalSetAttributes && {
        experimentalSetAttributes: afterRecovery(
          storage.runs.experimentalSetAttributes
        ),
      }),
      ...(storage.runs.waitForTerminalStatus && {
        waitForTerminalStatus: afterRecovery(
          storage.runs.waitForTerminalStatus
        ),
      }),
    },
    events: {
      ...storage.events,
      create: afterRecovery(storage.events.create),
      get: afterRecovery(storage.events.get),
      list: afterRecovery(storage.events.list),
      listByCorrelationId: afterRecovery(storage.events.listByCorrelationId),
    },
    steps: {
      get: afterRecovery(storage.steps.get),
      list: afterRecovery(storage.steps.list),
    },
    hooks: {
      get: afterRecovery(storage.hooks.get),
      getByToken: afterRecovery(storage.hooks.getByToken),
      list: afterRecovery(storage.hooks.list),
    },
    ...(storage.experimental_snapshots && {
      experimental_snapshots: {
        save: afterRecovery(storage.experimental_snapshots.save),
        load: afterRecovery(storage.experimental_snapshots.load),
        delete: afterRecovery(storage.experimental_snapshots.delete),
      },
    }),
    streams: {
      ...streamer.streams,
      write: afterRecovery(streamer.streams.write),
      close: afterRecovery(streamer.streams.close),
      ...(streamer.streams.writeMulti && {
        writeMulti: afterRecovery(streamer.streams.writeMulti),
      }),
      get: afterRecovery(streamer.streams.get),
      getChunks: afterRecovery(streamer.streams.getChunks),
      getInfo: afterRecovery(streamer.streams.getInfo),
      list: afterRecovery(streamer.streams.list),
    },
    ...(config.streamFlushIntervalMs !== undefined && {
      streamFlushIntervalMs: config.streamFlushIntervalMs,
    }),
    async start() {
      await queue.start();
      await reenqueueActiveRuns(
        storage.runs,
        queue.queue,
        'world-postgres',
        config.namespace
      );
    },
    async close() {
      closing = true;
      await queue.close();
      await streamer.close();
      await runStatusListener.close();
      if (pool !== config.pool) {
        await pool.end();
      }
    },
  };
}

/**
 * The pool the World creates when the caller passes none.
 *
 * It listens for connection errors on the pool and on every client it
 * connects (see `handleConnectionErrors`): a database restart or
 * `pg_terminate_backend` emits `error` on an idle client, which pg-pool
 * re-emits on the pool, and on a checked-out client, which pg-pool does not
 * listen on at all. With no listener either is an uncaught exception.
 * Graphile Worker listens only while the queue runs, and `pool.end()`
 * resolves before its idle clients have closed, so without this a backend
 * terminated during or after `close()` ends the process. The dropped client
 * leaves the pool, and the next query opens a new one.
 */
function createOwnedPool(
  config: PostgresWorldConfig,
  maxPoolSize: number | undefined,
  isClosing: () => boolean
): Pool {
  const pool = new Pool({
    connectionString: config.connectionString || getDefaultConnectionString(),
    ...(maxPoolSize !== undefined ? { max: maxPoolSize } : {}),
  });
  handleConnectionErrors(pool, isClosing);
  return pool;
}

// Re-export schema for users who want to extend or inspect the database schema
export type { PostgresWorldConfig } from './config.js';
export * from './drizzle/schema.js';
