import type {
  QueuePrefix,
  Wait,
  World,
  WorldCapabilities,
} from '@workflow/world';
import { mintedSpecVersion, reenqueueActiveRuns } from '@workflow/world';
import { warnIfRunningInVercelDeployment } from './build-target-mismatch.js';
import type { Config } from './config.js';
import { config, resolveRecoverActiveRuns } from './config.js';
import { decode } from './db/codec.js';
import { databaseFor } from './db/index.js';
import { initDataDir } from './init.js';
import { instrumentObject } from './instrumentObject.js';
import {
  createReleasePipeline,
  releaseOrphanedSteps,
} from './orphaned-steps.js';
import { createQueue, type DirectHandler } from './queue.js';
import { createQueueAuthKey } from './queue-auth-key.js';
import { backstopWakeDelaySeconds } from './recovery-wake.js';
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
 * @param args.recoverActiveRuns - Whether `start()` should re-enqueue pending/running runs from storage (default: `true`; falls back to the `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS` env var when unset)
 * @param args.tag - Optional tag (e.g., `vitest-0`) scoping the runs and
 *   streams this World writes; `clear()` only deletes this tag's data.
 * @param args.queueAuthKey - `'regenerate'` (default) writes a new queue auth key to the data
 *   directory when the World is created; `'read'` only reads the key a running app wrote (the
 *   CLI, the web UI). See `Config.queueAuthKey`.
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
  // Before the queue, which waits for it: a regenerating World writes the
  // app's new key before it sends anything.
  const queueAuthKey = createQueueAuthKey(
    mergedConfig.dataDir,
    mergedConfig.queueAuthKey ?? 'regenerate'
  );
  const queue = createQueue(mergedConfig, { queueAuthKey });
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
    // `start({ experimental_hook })`: the start Hook's token, the run, its Hook and its
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
    // one at a time (a per-run gate where they are sent and one where they
    // are handled, see queue.ts): with the fence, the two halves of the
    // single-writer guarantee. An in-band write is stored at its `occurredAt`.
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
    // The queue, its handlers and `queueAuthMode: 'loopback'`; `close()` is
    // the World's own, below.
    ...queue,
    ...storage,
    ...instrumentObject('world.streams', {
      ...streamer,
      ...(mergedConfig.streamFlushIntervalMs !== undefined && {
        streamFlushIntervalMs: mergedConfig.streamFlushIntervalMs,
      }),
    }),
    async start() {
      await initDataDir(mergedConfig.dataDir);
      if (!recoverActiveRuns) {
        return;
      }
      // The queue is in memory: a restart loses every message a run had
      // queued (its step messages, its wait timers). Every active run of this
      // World's tag is re-enqueued (a tagged World recovers only its tag, an
      // untagged one only untagged runs, so a dev server never recovers a
      // test's runs), after its steps that were running inline in the
      // previous process are released. Recovery assumes this is the only
      // live process on this data directory and tag.
      //
      // The recovery delivery is what re-arms a run's lost wait timers: a
      // spec 8 replay suspends on the open wait again and re-arms it, and the
      // recovery message carries a recovery marker, so a single-orchestrator
      // (spec 9) delivery sends the run's step messages and wait timers again
      // (chained in hops for a wait longer than one queue delay). So a spec 9
      // wait gets two wakes; one is a no-op.
      //
      // On top of that, as a backstop, every open wait of a recovered run due
      // within one queue timer gets a plain wake of its own, due when the
      // wait is (see `backstopWakeDelaySeconds`): a wait whose timer is lost
      // leaves a run asleep forever, so it is worth one more message.
      const releases = createReleasePipeline(storage);
      const recoveryRuns = {
        ...storage.runs,
        list: (async (params) => {
          const page = await storage.runs.list({ ...params, ownTagOnly: true });
          releases.prefetch(page.data.map((run) => run.runId));
          return page;
        }) as typeof storage.runs.list,
      };
      const releaseThenEnqueue: typeof queue.queue = async (
        queueName,
        message,
        opts
      ) => {
        const { runId, runSpecVersion } = message as {
          runId: string;
          runSpecVersion?: number;
        };
        await releases.settle(runId);
        const sent = await queue.queue(queueName, message, opts);
        await wakeOpenWaits(queueName, runId, runSpecVersion);
        return sent;
      };
      const wakeOpenWaits = async (
        queueName: Parameters<typeof queue.queue>[0],
        runId: string,
        runSpecVersion: number | undefined
      ) => {
        const now = Date.now();
        for (const wait of openWaits(mergedConfig.dataDir, runId)) {
          const resumeAt = wait.resumeAt
            ? new Date(wait.resumeAt).getTime()
            : now;
          const delaySeconds = backstopWakeDelaySeconds(resumeAt, now);
          if (delaySeconds === undefined) continue;
          try {
            await queue.queue(
              queueName,
              {
                runId,
                ...(runSpecVersion !== undefined && { runSpecVersion }),
                requestedAt: new Date(),
              },
              {
                delaySeconds,
                idempotencyKey: `recovery-wait:${runId}:${wait.waitId}:${resumeAt}`,
              }
            );
          } catch (error) {
            console.warn(
              `[world-local] Failed to re-arm wait ${wait.waitId} of run ${runId}: ${error}`
            );
          }
        }
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
      // The key is written behind createWorld(): never leave that write in
      // flight past close() (a caller may remove the directory next).
      await queueAuthKey.current().catch(() => {});
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
            'stream_chunks',
            'snapshots',
            'runs',
          ]) {
            db.run(`DELETE FROM ${table}`);
          }
          return;
        }
        // Only this tag's data: its runs and everything they own, and its
        // streams.
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
        db.run('DELETE FROM stream_chunks WHERE tag = ?', tag);
        db.run('DELETE FROM runs WHERE tag = ?', tag);
      });
    },
  };
}

/** A run's waits that have not completed. */
function openWaits(dataDir: string, runId: string): Wait[] {
  return databaseFor(dataDir)
    .all<{ doc: string }>('SELECT doc FROM waits WHERE run_id = ?', runId)
    .map((row) => decode<Wait>(row.doc))
    .filter((wait) => wait.status === 'waiting');
}
