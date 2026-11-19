import type { Queue, Storage, World, WorldCapabilities } from '@workflow/world';
import {
  mintedSpecVersion,
  orchestratorRunIdOf,
  reenqueueActiveRuns,
} from '@workflow/world';
import { Pool } from 'pg';
import {
  type PostgresWorldConfig,
  resolveJobPrefix,
  UNPINNED_DEPLOYMENT_ID,
} from './config.js';
import { handleConnectionErrors } from './connection-errors.js';
import { createClient, type Drizzle } from './drizzle/index.js';
import { createQueue } from './queue.js';
import { worldPurgeTask } from './retention.js';
import { createRunEventsFeed, type RunEventsFeed } from './run-events.js';
import {
  createRunStatusListener,
  type RunStatusListener,
} from './run-status.js';
import { createSnapshotsStorage } from './snapshots.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRecoverableRunsList,
  createRunsStorage,
  createStepsStorage,
} from './storage.js';
import { createStreamer } from './streamer.js';

function createStorage(
  drizzle: Drizzle,
  runStatusListener: RunStatusListener,
  jobPrefix: string,
  purgeTask: string,
  runEventsFeed: RunEventsFeed,
  rateLimitScope: string
): Storage {
  return {
    runs: createRunsStorage(drizzle, runStatusListener),
    events: createEventsStorage(drizzle, {
      jobPrefix,
      purgeTask,
      runEventsFeed,
      rateLimitScope,
    }),
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
    deploymentId: process.env.WORKFLOW_POSTGRES_DEPLOYMENT_ID || undefined,
    queueConcurrency:
      parseInt(process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY || '50', 10) ||
      50,
    pollInterval: getPositiveIntEnv('WORKFLOW_POSTGRES_POLL_INTERVAL_MS'),
    applicationManagedShutdown:
      process.env.WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN === '1',
    skipWorkers: process.env.WORKFLOW_POSTGRES_SKIP_WORKERS === '1',
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
  const queue = createQueue(config, pool);
  // Opens its `LISTEN` connection lazily, on the first `waitForTerminalStatus`
  // call, so a deployment that never awaits a run never pays for it.
  const runStatusListener = createRunStatusListener(pool);
  // The prefix of the Graphile task this World's runner claims. Stamped on
  // every run this World creates, and the scope of its startup recovery.
  const jobPrefix = resolveJobPrefix(config);
  // `events.subscribe` for spec 9 orchestrators: one `LISTEN` connection,
  // opened on the first subscription. Lingering on it holds a worker slot,
  // so at most half of this process's slots linger at once. With a single
  // slot the feed is off: a lingering delivery would hold the only slot
  // while the background steps it waits for queue behind it.
  const workerSlots = config.queueConcurrency || 50;
  const runEventsFeed = createRunEventsFeed(pool, {
    maxLiveSubscriptions: workerSlots < 2 ? 0 : Math.floor(workerSlots / 2),
  });
  const storage = createStorage(
    drizzle,
    runStatusListener,
    jobPrefix,
    worldPurgeTask(config),
    runEventsFeed,
    // Rate limit keys are shared by every deployment of this app (its base
    // `jobPrefix`, without the deployment), as on the Vercel World, where a
    // key is shared by the project's deployments in one environment.
    resolveJobPrefix(config, undefined)
  );
  const streamer = createStreamer(pool, drizzle);

  const capabilities = {
    hookRetention: { active: true },
    // `start({ experimental_hook })`: the decision, the start Hook and the run it
    // admits commit in one transaction; see start-hook.ts. Every worker
    // serving the database must run a version with start Hook support before
    // a caller passes `experimental_hook` (an older one would create a candidate's run
    // without its start Hook).
    atomicStartHook: { active: true },
    // Stored in the runs table's `dynamic_workflow_code_cbor` column; no
    // upload path, so `start()` always sends the code inline.
    dynamicWorkflowCode: true,
    hookResumeDedup: true,
    ...(config.enableInvoke ? { invoke: true } : {}),
    // One transaction re-points the token, journals the victim's
    // `hook_disposed{forceClaimedBy}` and creates the claimer's hook; see
    // the hook_created branch of storage.ts.
    hookForceClaim: true,
    // A single-orchestrator run's orchestrator deliveries take one run
    // delivery lease (see run-lease.ts), and the events storage fences
    // in-band writes and stores them at their `occurredAt` (see
    // storage.ts): the two halves of the single-writer guarantee.
    maxConcurrency: true,
    // Required by the runtime; see in-band-fence.test.ts for conformance.
    inBandFence: true,
    // `experimental_rateLimit()`: each key's next free slot is a row of
    // `workflow_rate_limits`, reserved under its lock in the fenced
    // `rate_created` write's transaction (see `reserveRateSlot` in
    // storage.ts). Not `rateEventsInBatch`: this World has no batch write.
    rateLimits: true,
    // With a `deploymentId`, each deployment's workers claim only its own
    // runs' jobs and messages for another deployment's runs are routed to
    // its task (queue.ts), so a run executes only where it started.
    ...(config.deploymentId !== undefined
      ? { deploymentAffinity: true as const }
      : {}),
  } satisfies WorldCapabilities;
  return {
    // Spec 9 runs by default, which need the in-band fence declared above;
    // `WORKFLOW_SPEC_VERSION=8` keeps new runs on spec 8, and `10` creates
    // spec 10 runs, which also need the rate limits declared above.
    specVersion: mintedSpecVersion(process.env, {
      inBandFence: capabilities.inBandFence,
      rateLimits: capabilities.rateLimits,
    }),
    capabilities,
    ...storage,
    ...streamer,
    ...queue,
    ...(config.streamFlushIntervalMs !== undefined && {
      streamFlushIntervalMs: config.streamFlushIntervalMs,
    }),
    async start() {
      await queue.start();
      // Recovery enqueues runs for this World's own workers. Without workers,
      // a run this process created but didn't get to enqueue is recovered the
      // next time a process with workers starts. Every boot of such a process
      // would otherwise re-enqueue every active run.
      if (config.skipWorkers) {
        // Its runs execute only on workers that share the database, the job
        // prefix and the deployment ID: if none does, they stay pending. The
        // configured prefix, not `jobPrefix` (which has the deployment ID
        // appended), so it compares with the workers' WORKFLOW_POSTGRES_JOB_PREFIX.
        console.info(
          `[world-postgres] skipWorkers: this process runs no workers. Its runs execute on processes with workers on the same database, jobPrefix ${JSON.stringify(resolveJobPrefix({ jobPrefix: config.jobPrefix }))} and deploymentId ${JSON.stringify(config.deploymentId ?? UNPINNED_DEPLOYMENT_ID)}.`
        );
        return;
      }
      // Recover only this World's runs (and unstamped legacy ones): every
      // recovered run lands in this World's own task, so a run created under
      // another `jobPrefix` would be driven by the wrong app's runner. The
      // listing leaves out runs parked on a hook or a wait (see
      // `createRecoverableRunsList`), and each run's recovery job is keyed by
      // the run, so a boot replaces the job an earlier boot left queued
      // rather than adding another. A parked run with a locked orchestrator
      // job, a delivery that may have been cut off, is recovered anyway.
      await reenqueueActiveRuns(
        {
          ...storage.runs,
          list: createRecoverableRunsList(
            drizzle,
            jobPrefix,
            await queue.lockedOrchestratorRunIds()
          ),
        },
        (queueName, message, opts) =>
          queue.queue(queueName, message, {
            ...opts,
            jobKey: `startup-recovery:${orchestratorRunIdOf(message)}`,
          }),
        'world-postgres',
        config.namespace
      );
    },
    async close() {
      closing = true;
      await queue.close();
      await streamer.close();
      await runStatusListener.close();
      await runEventsFeed.close();
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
