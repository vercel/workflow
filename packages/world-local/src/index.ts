import { promises as fs } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { QueuePrefix, World } from '@workflow/world';
import { mintedSpecVersion, reenqueueActiveRuns } from '@workflow/world';
import { warnIfRunningInVercelDeployment } from './build-target-mismatch.js';
import type { Config } from './config.js';
import { config, resolveRecoverActiveRuns } from './config.js';
import {
  clearCreatedFilesCache,
  deleteJSON,
  hasTag,
  isUntagged,
  listTaggedFiles,
  listTaggedFilesByExtension,
  readJSON,
  settleAll,
} from './fs.js';
import { initDataDir } from './init.js';
import { instrumentObject } from './instrumentObject.js';
import { createQueue, type DirectHandler } from './queue.js';
import { QUEUE_JOURNAL_DIR } from './queue-journal.js';
import { hashToken, hookRecoveryMarkerPath } from './storage/helpers.js';
import { resetHookIndexEnsureCache } from './storage/hook-index.js';
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
  /** Clear all workflow data (runs, steps, events, hooks, streams). */
  clear(): Promise<void>;
};

/**
 * Delete one tag's lock files: dispose locks, terminal markers, create
 * claims and staged hook events, all named `.locks/<kind>/<id>.<state>.<tag>`.
 *
 * `.locks` is shared by every tag, and a lock is the durable record that its
 * hook or entity is closed, so a tagged `clear()` must leave other tags' locks
 * alone. Vitest workers each clear under their own tag when a test file
 * starts, while other workers' runs are in flight: deleting a disposed hook's
 * lock there makes it look live to the token claim rebuild, and the run that
 * recreates its token then conflicts with its own disposed hook.
 */
async function clearTaggedLocks(basedir: string, tag: string): Promise<void> {
  const locksDir = path.join(basedir, '.locks');
  let lockKindEntries: import('node:fs').Dirent[];
  try {
    lockKindEntries = await fs.readdir(locksDir, { withFileTypes: true });
  } catch {
    lockKindEntries = [];
  }
  await settleAll(
    lockKindEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const lockKindDir = path.join(locksDir, entry.name);
        const lockNames = await fs
          .readdir(lockKindDir)
          .catch(() => [] as string[]);
        await settleAll(
          lockNames
            .filter((name) => name.endsWith(`.${tag}`))
            .map((name) =>
              // Recursive: a run's staged hook events are a directory.
              fs.rm(path.join(lockKindDir, name), {
                recursive: true,
                force: true,
              })
            )
        );
      })
  );
}

/**
 * Creates a local world instance that combines queue, storage, and streamer functionalities.
 *
 * @param args - Optional configuration object
 * @param args.dataDir - Directory for storing workflow data (default: `.workflow-data/`)
 * @param args.port - Port override for queue transport (default: auto-detected)
 * @param args.baseUrl - Full base URL override for queue transport (default: `http://localhost:{port}`)
 * @param args.recoverActiveRuns - Whether `start()` should deliver again the queue messages a dead process was delivering and re-enqueue pending/running runs from storage (default: `true`; falls back to the `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS` env var when unset)
 * @param args.tag - Optional tag to scope files (e.g., `vitest-0`). When set, files are written
 *   as `{id}.{tag}.json` and `clear()` only deletes files matching this tag.
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
  const { redeliverOrphans, ...queue } = createQueue(mergedConfig);
  const { clearCache: clearStorageCache, ...storage } = createStorage(
    mergedConfig.dataDir,
    tag
  );
  const recoverActiveRuns = resolveRecoverActiveRuns(mergedConfig);
  return {
    specVersion: mintedSpecVersion(),
    capabilities: {
      hookRetention: { active: true },
      // Stored whole on the run record; no upload path, so `start()` always
      // sends the code inline.
      dynamicWorkflowCode: true,
      // world-local deduplicates concurrent `hook_received` writes sharing a
      // `(runId, resumeId)` via a filesystem sidecar claim (see
      // events-storage.ts `claimHookResume`), so resumeHook()'s parallel fast
      // path converges on one event in dev exactly as it does on Vercel.
      hookResumeDedup: true,
      // The token claim lock serializes the takeover behind
      // `createHook({ experimental_force: true })`; see the hook_created
      // branch of storage/events-storage.ts.
      hookForceClaim: true,
    },
    ...queue,
    ...storage,
    ...instrumentObject('world.streams', {
      ...createStreamer(mergedConfig.dataDir, tag),
      ...(mergedConfig.streamFlushIntervalMs !== undefined && {
        streamFlushIntervalMs: mergedConfig.streamFlushIntervalMs,
      }),
    }),
    async start() {
      await initDataDir(mergedConfig.dataDir);
      if (!recoverActiveRuns) {
        return;
      }
      // Scope recovery to this world's own files. A tagged world recovers only
      // its tag; an untagged world recovers only untagged files. Without the
      // untagged filter, an untagged dev server sharing the data directory with
      // the vitest harness would list tagged runs (list enumerates every file)
      // and re-enqueue them, but run_started's tagged-or-untagged read can't
      // resolve a foreign tag, yielding "did not return the run entity" 500s
      // on startup until the message exhausts its deliveries.
      const fileIdFilter = tag
        ? (fileId: string) => hasTag(fileId, tag)
        : isUntagged;
      const recoveryRuns = {
        ...storage.runs,
        list: ((params) =>
          storage.runs.list({
            ...params,
            fileIdFilter,
          })) as typeof storage.runs.list,
      };
      // First the messages a dead process was delivering, each with its own
      // messageId: the runtime recovers a step left running under a message
      // only when that same message comes back. The re-enqueue of active runs
      // after it is the backstop for runs no journaled message covers.
      await redeliverOrphans();
      await reenqueueActiveRuns(recoveryRuns, queue.queue, 'world-local');
    },
    async close() {
      clearStorageCache();
      await queue.close();
    },
    async clear() {
      clearStorageCache();
      if (tag) {
        // Selectively delete only files matching this tag
        const basedir = mergedConfig.dataDir;

        // Delete hook token constraint files (and recovery markers,
        // for disk hygiene) BEFORE deleting the hooks, since we need
        // to read each hook to extract its token hash. Constraint
        // files and markers are untagged (`{sha256}.json` and
        // `{sha256}.recovery.json`) so listTaggedFiles won't find
        // them. We must resolve them via the hook data.
        const hooksDir = path.join(basedir, 'hooks');
        const taggedHookFiles = await listTaggedFiles(hooksDir, tag);
        const { HookSchema } = await import('@workflow/world');
        await settleAll(
          taggedHookFiles.map(async (hookFile) => {
            const hook = await readJSON(
              path.join(hooksDir, hookFile),
              HookSchema
            );
            if (hook?.token) {
              await deleteJSON(
                path.join(hooksDir, 'tokens', `${hashToken(hook.token)}.json`)
              );
              await deleteJSON(
                hookRecoveryMarkerPath(
                  basedir,
                  hook.token,
                  hook.runId,
                  hook.hookId
                )
              );
            }
          })
        );

        // Delete tagged entity files across all directories. Steps and
        // events live one directory per run, so walk only this tag's runs
        // (found from `runs/*.<tag>.json`) rather than every run the shared
        // data directory holds.
        const runScopedDirs = (
          await listTaggedFiles(path.join(basedir, 'runs'), tag)
        ).flatMap((file) => {
          const runId = file.slice(0, -`.${tag}.json`.length);
          return [path.join('steps', runId), path.join('events', runId)];
        });
        const entityDirs = [
          'runs',
          ...runScopedDirs,
          'hooks',
          'hooks/by-run',
          'waits',
          'streams/runs',
          QUEUE_JOURNAL_DIR,
        ];
        await settleAll(
          entityDirs.map(async (dir) => {
            const fullDir = path.join(basedir, dir);
            const files = await listTaggedFiles(fullDir, tag);
            await settleAll(
              files.map((f) => deleteJSON(path.join(fullDir, f)))
            );
          })
        );
        // Drop the run directories that clearing left empty. `rmdir` refuses
        // a non-empty one, so another tag's (or untagged) files keep theirs.
        await settleAll(
          runScopedDirs.map((dir) =>
            fs.rmdir(path.join(basedir, dir)).catch(() => {})
          )
        );
        // Delete tagged hook-index entries (nested per-key directories)
        for (const indexDir of ['token-index', 'id-index']) {
          const fullIndexDir = path.join(basedir, 'hooks', indexDir);
          let keyDirEntries: import('node:fs').Dirent[];
          try {
            keyDirEntries = await fs.readdir(fullIndexDir, {
              withFileTypes: true,
            });
          } catch {
            keyDirEntries = [];
          }
          await settleAll(
            keyDirEntries
              .filter((entry) => entry.isDirectory())
              .map(async (entry) => {
                const keyDir = path.join(fullIndexDir, entry.name);
                const taggedEntryFiles = await listTaggedFiles(keyDir, tag);
                await settleAll(
                  taggedEntryFiles.map((f) => deleteJSON(path.join(keyDir, f)))
                );
              })
          );
        }
        await clearTaggedLocks(basedir, tag);
        // Delete tagged stream chunks (.{tag}.bin files). Chunks are sharded
        // one directory per stream (streams/chunks/<streamName>/<chunkId>.{tag}.bin),
        // so iterate each per-stream directory: the top-level chunks dir now
        // holds only subdirectories, so listing it directly would match nothing
        // and silently leak tagged chunk files across test sessions.
        const chunksDir = path.join(basedir, 'streams', 'chunks');
        let streamDirEntries: import('node:fs').Dirent[];
        try {
          streamDirEntries = await fs.readdir(chunksDir, {
            withFileTypes: true,
          });
        } catch {
          streamDirEntries = [];
        }
        await settleAll(
          streamDirEntries
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
              const streamChunkDir = path.join(chunksDir, entry.name);
              const taggedBinFiles = await listTaggedFilesByExtension(
                streamChunkDir,
                tag,
                '.bin'
              );
              await settleAll(
                taggedBinFiles.map((f) =>
                  fs.unlink(path.join(streamChunkDir, f)).catch(() => {})
                )
              );
            })
        );
        // Clear the in-memory write cache so deleted paths are forgotten
        clearCreatedFilesCache();
      } else {
        // `rm()` removes directories that the write path may have cached.
        clearCreatedFilesCache();
        resetHookIndexEnsureCache();
        await rm(mergedConfig.dataDir, { recursive: true, force: true });
        await initDataDir(mergedConfig.dataDir);
      }
    },
  };
}
