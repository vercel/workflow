import type { QueuePrefix, World, WorldCapabilities } from '@workflow/world';
import { mintedSpecVersion, reenqueueActiveRuns } from '@workflow/world';
import { warnIfRunningInVercelDeployment } from './build-target-mismatch.js';
import type { Config } from './config.js';
import { config, resolveRecoverActiveRuns } from './config.js';
import { databaseFor } from './db/index.js';
import { initDataDir } from './init.js';
import { instrumentObject } from './instrumentObject.js';
import {
  createReleasePipeline,
  releaseOrphanedSteps,
} from './orphaned-steps.js';
import { createQueue, type DirectHandler } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

export { UnwritableDataDirError } from './build-target-mismatch.js';
// Re-export init types and utilities for consumers
export {
  DataDirAccessError,
  DataDirLayoutError,
  DataDirVersionError,
  ensureDataDir,
  initDataDir,
  type ParsedVersion,
  parseVersion,
} from './init.js';

export type { DirectHandler } from './queue.js';

export type LocalWorld = World & {
  /** Register a direct in-process handler for a queue prefix, bypassing HTTP. */
  registerHandler(prefix: QueuePrefix, handler: DirectHandler): void;
  /**
   * Deliver a queue prefix's messages over HTTP to `path` on the app (for
   * example `/api/agent/queue`) instead of the Workflow SDK's flow route.
   */
  registerRoute(prefix: QueuePrefix, path: string): void;
  /** Clear all workflow data (runs, steps, events, hooks, streams). */
  clear(): Promise<void>;
  /**
   * Hand a run's steps that were running inline in a previous process back to
   * the queue, so the next delivery dispatches them at once instead of
   * waiting out the inline-ownership lease. `start()` does this for every run
   * it recovers; call it yourself before re-enqueueing a run when recovering
   * with `recoverActiveRuns: false`. A run that has already finished is left
   * alone.
   *
   * Steps started since world-local loaded in this process or worker thread
   * are never released, so calling it late, or while this process runs the
   * run, is safe. Steps started earlier are treated as abandoned: call it only
   * when no other live process or worker thread runs workflows on this data
   * directory and tag, or a step still running there would run twice.
   */
  releaseOrphanedSteps(runId: string): Promise<void>;
};

/**
 * Creates a local world: storage, queue and streams in one SQLite database,
 * `<dataDir>/world.db`.
 *
 * @param args - Optional configuration object
 * @param args.dataDir - Directory for storing workflow data (default: `.workflow-data/`)
 * @param args.port - Port override for queue transport (default: auto-detected)
 * @param args.baseUrl - Full base URL override for queue transport (default: `http://localhost:{port}`)
 * @param args.recoverActiveRuns - Whether `start()` should re-enqueue pending/running runs that have no queued message (default: `true`; falls back to the `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS` env var when unset)
 * @param args.tag - Optional tag (e.g., `vitest-0`) scoping the runs, queue
 *   messages and streams this World writes; `clear()` only deletes this tag's data.
 * @throws {DataDirAccessError} If the data directory cannot be created or accessed
 * @throws {DataDirVersionError} If the data directory version is incompatible
 */
export function createWorld(args?: Partial<Config>): LocalWorld {
  const definedArgs = args
    ? Object.fromEntries(
        Object.entries(args).filter(([, value]) => value !== undefined)
      )
    : {};
  const mergedConfig = { ...config.value, ...definedArgs };
  warnIfRunningInVercelDeployment(mergedConfig.dataDir);
  const tag = mergedConfig.tag;
  const queue = createQueue(mergedConfig);
  const { clearCache: _clearStorageCache, ...storage } = createStorage(
    mergedConfig.dataDir,
    tag
  );
  const { clearCache: _clearStreamerCache, ...streamer } = createStreamer(
    mergedConfig.dataDir,
    tag
  );
  const recoverActiveRuns = resolveRecoverActiveRuns(mergedConfig);
  const capabilities = {
    hookRetention: { active: true },
    // `start({ hook })`: the start Hook's token, the run, its Hook and its
    // run_created commit in one transaction, or the refusal is recorded.
    atomicStartHook: { active: true },
    // Stored whole on the run record; no upload path, so `start()` always
    // sends the code inline.
    dynamicWorkflowCode: true,
    // `hook_received` writes sharing a `(runId, resumeId)` converge on one
    // event (the `hook_resumes` table).
    hookResumeDedup: true,
    // `createHook({ experimental_force: true })` takes a token over in one
    // transaction, writing the holder's `hook_disposed`.
    hookForceClaim: true,
    // The queue delivers a single-orchestrator run's orchestrator messages
    // one at a time across every process (lanes, see queue.ts): with the
    // fence, the two halves of the single-writer guarantee. An in-band write
    // is stored at its `occurredAt`.
    maxConcurrency: true,
    // The per-run in-band count is a column of the run's row, checked and
    // advanced in the write's transaction.
    inBandFence: true,
  } satisfies WorldCapabilities;
  return {
    // Spec 9 runs only on request (`WORKFLOW_SPEC_VERSION=9`), which needs
    // the in-band fence declared above; spec 8 otherwise.
    specVersion: mintedSpecVersion(process.env, {
      inBandFence: capabilities.inBandFence,
    }),
    capabilities,
    queue: queue.queue,
    createQueueHandler: queue.createQueueHandler,
    getDeploymentId: queue.getDeploymentId,
    registerHandler: queue.registerHandler,
    registerRoute: queue.registerRoute,
    ...storage,
    events: {
      ...storage.events,
      // A process that writes to the World also delivers its queue: after a
      // restart, the first write resumes the messages the previous process
      // left (wait timers, retries, its in-flight deliveries).
      create: ((...args: Parameters<typeof storage.events.create>) => {
        queue.startConsumer();
        return storage.events.create(...args);
      }) as typeof storage.events.create,
    },
    ...instrumentObject('world.streams', {
      ...streamer,
      ...(mergedConfig.streamFlushIntervalMs !== undefined && {
        streamFlushIntervalMs: mergedConfig.streamFlushIntervalMs,
      }),
    }),
    async start() {
      await initDataDir(mergedConfig.dataDir);
      queue.startConsumer();
      if (!recoverActiveRuns) {
        return;
      }
      // The queue is durable: a run's queued messages (deliveries, wait
      // timers, retries) are still there and are delivered again, including
      // one whose delivery a dead process held. Recovery only re-enqueues
      // the active runs that have no message at all (their messages were
      // lost, for example because they were written by an older release
      // whose queue was in memory), and only this World's tag: a dev server
      // never recovers a test's runs. Such a run's inline-owned steps belong
      // to a previous process, so they are released first.
      const releases = createReleasePipeline(storage);
      const recoveryRuns = {
        ...storage.runs,
        list: (async (params) => {
          const page = await storage.runs.list({ ...params, ownTagOnly: true });
          const queued = queue.runsWithMessages(
            page.data.map((run) => run.runId)
          );
          const data = page.data.filter((run) => !queued.has(run.runId));
          releases.prefetch(data.map((run) => run.runId));
          return { ...page, data };
        }) as typeof storage.runs.list,
      };
      const releaseThenEnqueue: typeof queue.queue = async (
        queueName,
        message,
        opts
      ) => {
        await releases.settle((message as { runId: string }).runId);
        return queue.queue(queueName, message, opts);
      };
      await reenqueueActiveRuns(
        recoveryRuns,
        releaseThenEnqueue,
        'world-local',
        undefined,
        { queueLost: true }
      );
    },
    releaseOrphanedSteps(runId) {
      return releaseOrphanedSteps(storage, runId);
    },
    async close() {
      await queue.close();
      // Other Worlds on the data directory reopen it on their next use.
      databaseFor(mergedConfig.dataDir).close();
    },
    async clear() {
      const db = databaseFor(mergedConfig.dataDir);
      db.transact(() => {
        if (tag === undefined) {
          for (const table of [
            'events',
            'steps',
            'waits',
            'hooks',
            'hook_disposals',
            'hook_tokens',
            'hook_resumes',
            'start_hook_rejections',
            'messages',
            'stream_chunks',
            'snapshots',
            'runs',
          ]) {
            db.run(`DELETE FROM ${table}`);
          }
          return;
        }
        // Only this tag's data: its runs and everything they own, and its
        // queue messages and streams.
        const runs = 'SELECT run_id FROM runs WHERE tag = ?';
        for (const table of [
          'events',
          'steps',
          'waits',
          'hook_disposals',
          'hook_resumes',
          'snapshots',
        ]) {
          db.run(`DELETE FROM ${table} WHERE run_id IN (${runs})`, tag);
        }
        db.run(
          `DELETE FROM hook_tokens WHERE run_id IN (${runs}) OR hook_id IN (SELECT hook_id FROM hooks WHERE tag = ?)`,
          tag,
          tag
        );
        db.run('DELETE FROM hooks WHERE tag = ?', tag);
        db.run('DELETE FROM start_hook_rejections WHERE tag = ?', tag);
        db.run('DELETE FROM messages WHERE tag = ?', tag);
        db.run('DELETE FROM stream_chunks WHERE tag = ?', tag);
        db.run('DELETE FROM runs WHERE tag = ?', tag);
      });
    },
  };
}
