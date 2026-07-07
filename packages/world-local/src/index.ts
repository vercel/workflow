import { promises as fs } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { QueuePrefix, World } from '@workflow/world';
import { reenqueueActiveRuns, SPEC_VERSION_CURRENT } from '@workflow/world';
import type { Config } from './config.js';
import { config } from './config.js';
import {
  clearCreatedFilesCache,
  deleteJSON,
  hasTag,
  isUntagged,
  listTaggedFiles,
  listTaggedFilesByExtension,
  readJSON,
} from './fs.js';
import { initDataDir } from './init.js';
import { instrumentObject } from './instrumentObject.js';
import { createQueue, type DirectHandler } from './queue.js';
import { hashToken, hookRecoveryMarkerPath } from './storage/helpers.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

// Re-export init types and utilities for consumers
export {
  DataDirAccessError,
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
 * Creates a local world instance that combines queue, storage, and streamer functionalities.
 *
 * @param args - Optional configuration object
 * @param args.dataDir - Directory for storing workflow data (default: `.workflow-data/`)
 * @param args.port - Port override for queue transport (default: auto-detected)
 * @param args.baseUrl - Full base URL override for queue transport (default: `http://localhost:{port}`)
 * @param args.recoverActiveRuns - Whether `start()` should re-enqueue pending/running runs from storage (default: `true`)
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
  const tag = mergedConfig.tag;
  const queue = createQueue(mergedConfig);
  const { clearCache: clearStorageCache, ...storage } = createStorage(
    mergedConfig.dataDir,
    tag
  );
  const recoverActiveRuns = mergedConfig.recoverActiveRuns ?? true;
  return {
    specVersion: SPEC_VERSION_CURRENT,
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
      // resolve a foreign tag — yielding "did not return the run entity" 500s
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
        // them — we must resolve them via the hook data.
        const hooksDir = path.join(basedir, 'hooks');
        const taggedHookFiles = await listTaggedFiles(hooksDir, tag);
        const { HookSchema } = await import('@workflow/world');
        await Promise.all(
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

        // Delete tagged entity files across all directories
        const entityDirs = [
          'runs',
          'steps',
          'events',
          'hooks',
          'waits',
          'streams/runs',
        ];
        await Promise.all(
          entityDirs.map(async (dir) => {
            const fullDir = path.join(basedir, dir);
            const files = await listTaggedFiles(fullDir, tag);
            await Promise.all(
              files.map((f) => deleteJSON(path.join(fullDir, f)))
            );
          })
        );
        // Clean up lock files used for atomic terminal-state guards
        await fs
          .rm(path.join(basedir, '.locks'), { recursive: true, force: true })
          .catch(() => {});
        // Delete tagged stream chunks (.{tag}.bin files)
        const chunksDir = path.join(basedir, 'streams', 'chunks');
        const taggedBinFiles = await listTaggedFilesByExtension(
          chunksDir,
          tag,
          '.bin'
        );
        await Promise.all(
          taggedBinFiles.map((f) =>
            fs.unlink(path.join(chunksDir, f)).catch(() => {})
          )
        );
        // Clear the in-memory write cache so deleted paths are forgotten
        clearCreatedFilesCache();
      } else {
        // `rm()` removes directories that the write path may have cached.
        clearCreatedFilesCache();
        await rm(mergedConfig.dataDir, { recursive: true, force: true });
        await initDataDir(mergedConfig.dataDir);
      }
    },
  };
}

/**
 * @deprecated Use `createWorld()` instead.
 */
export function createLocalWorld(args?: Partial<Config>): LocalWorld {
  return createWorld(args);
}
