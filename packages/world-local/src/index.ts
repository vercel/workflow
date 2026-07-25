import { promises as fs } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  EntityConflictError,
  WorkflowRunNotFoundError,
} from '@workflow/errors';
import type { QueuePrefix, World } from '@workflow/world';
import { reenqueueActiveRuns, SPEC_VERSION_CURRENT } from '@workflow/world';
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
  taggedPath,
} from './fs.js';
import { initDataDir } from './init.js';
import { instrumentObject } from './instrumentObject.js';
import { createQueue, type DirectHandler } from './queue.js';
import { hashToken, hookRecoveryMarkerPath } from './storage/helpers.js';
import {
  deleteHookByRunMarkerFile,
  listHookByRunMarkers,
  resetHookIndexEnsureCache,
} from './storage/hook-index.js';
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

interface PurgedTreeManifest {
  rootRunId: string;
  runIds: string[];
  descendantAttribute?: { key: string; value: string };
}

function createExclusiveMutation() {
  let tail = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

/**
 * Creates a local world instance that combines queue, storage, and streamer functionalities.
 *
 * @param args - Optional configuration object
 * @param args.dataDir - Directory for storing workflow data (default: `.workflow-data/`)
 * @param args.port - Port override for queue transport (default: auto-detected)
 * @param args.baseUrl - Full base URL override for queue transport (default: `http://localhost:{port}`)
 * @param args.recoverActiveRuns - Whether `start()` should re-enqueue pending/running runs from storage (default: `true`; falls back to the `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS` env var when unset)
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
  const recoverActiveRuns = resolveRecoverActiveRuns(mergedConfig);
  const streams = createStreamer(mergedConfig.dataDir, tag);
  const exclusiveMutation = createExclusiveMutation();
  const purgedRuns = new Set<string>();
  const purgedTrees = new Map<string, PurgedTreeManifest>();
  let purgeFencesLoaded = false;

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validates durable manifests defensively
  async function ensurePurgeFencesLoaded(): Promise<void> {
    if (purgeFencesLoaded) return;
    const dir = path.join(mergedConfig.dataDir, 'purged-trees');
    const files = tag
      ? await listTaggedFiles(dir, tag)
      : (await fs.readdir(dir).catch(() => [] as string[])).filter(
          (file) => file.endsWith('.json') && !file.slice(0, -5).includes('.')
        );
    for (const file of files) {
      try {
        const manifest = JSON.parse(
          await fs.readFile(path.join(dir, file), 'utf8')
        ) as PurgedTreeManifest;
        if (
          typeof manifest.rootRunId !== 'string' ||
          !Array.isArray(manifest.runIds)
        ) {
          continue;
        }
        purgedTrees.set(manifest.rootRunId, manifest);
        for (const runId of manifest.runIds) purgedRuns.add(runId);
      } catch {
        // A partial/corrupt manifest cannot safely establish a deletion fence.
      }
    }
    purgeFencesLoaded = true;
  }

  function assertRunWriteAllowed(
    runId: string | null,
    attributes?: Record<string, string>
  ): void {
    if (runId !== null && purgedRuns.has(runId)) {
      throw new EntityConflictError(`Workflow run ${runId} was purged`);
    }
    if (attributes !== undefined) {
      for (const manifest of purgedTrees.values()) {
        const selector = manifest.descendantAttribute;
        if (
          selector !== undefined &&
          attributes[selector.key] === selector.value
        ) {
          throw new EntityConflictError(
            `Workflow run tree ${manifest.rootRunId} was purged`
          );
        }
      }
    }
  }

  const experimentalSetAttributes = storage.runs.experimentalSetAttributes;
  const writeMulti = streams.streams.writeMulti;
  const fencedStorage = {
    ...storage,
    runs: {
      ...storage.runs,
      ...(experimentalSetAttributes === undefined
        ? {}
        : {
            experimentalSetAttributes: (runId, changes, options) =>
              exclusiveMutation(async () => {
                await ensurePurgeFencesLoaded();
                assertRunWriteAllowed(runId);
                return experimentalSetAttributes(runId, changes, options);
              }),
          }),
    },
    events: {
      ...storage.events,
      create: ((runId, data, params) =>
        exclusiveMutation(async () => {
          await ensurePurgeFencesLoaded();
          const attributes =
            data.eventType === 'run_created' || data.eventType === 'run_started'
              ? data.eventData?.attributes
              : undefined;
          assertRunWriteAllowed(runId, attributes);
          if (data.eventType === 'run_created') {
            return storage.events.create(runId, data, params);
          }
          if (runId === null) {
            throw new Error('runId is required for non-run_created events');
          }
          return storage.events.create(runId, data, params);
        })) as typeof storage.events.create,
    },
  } satisfies typeof storage;
  const fencedStreams = {
    ...streams.streams,
    write: (runId, name, chunk) =>
      exclusiveMutation(async () => {
        await ensurePurgeFencesLoaded();
        assertRunWriteAllowed(await runId);
        return streams.streams.write(runId, name, chunk);
      }),
    ...(writeMulti === undefined
      ? {}
      : {
          writeMulti: (runId, name, chunks) =>
            exclusiveMutation(async () => {
              await ensurePurgeFencesLoaded();
              assertRunWriteAllowed(await runId);
              return writeMulti(runId, name, chunks);
            }),
        }),
    close: (runId, name) =>
      exclusiveMutation(async () => {
        await ensurePurgeFencesLoaded();
        assertRunWriteAllowed(await runId);
        return streams.streams.close(runId, name);
      }),
  } satisfies typeof streams.streams;
  return {
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: { runTreePurge: true },
    ...queue,
    ...fencedStorage,
    ...instrumentObject('world.streams', {
      streams: fencedStreams,
      ...(mergedConfig.streamFlushIntervalMs !== undefined && {
        streamFlushIntervalMs: mergedConfig.streamFlushIntervalMs,
      }),
    }),
    // Purge deliberately keeps discovery, terminal fencing, and removal in
    // one method so no caller can invoke only a partial deletion phase.
    async purgeRunTree(rootRunId, options) {
      return exclusiveMutation(
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: atomic retention boundary
        async () => {
          await ensurePurgeFencesLoaded();
          const root = await storage.runs
            .get(rootRunId, { resolveData: 'none' })
            .catch((error: unknown) => {
              if (WorkflowRunNotFoundError.is(error)) return null;
              throw error;
            });
          if (root === null) {
            const prior = purgedTrees.get(rootRunId);
            if (prior !== undefined) {
              await removeRunTreeEntities(prior.runIds);
              return {
                purgedRunCount: prior.runIds.length,
                status: 'purged' as const,
              };
            }
            return { purgedRunCount: 0, status: 'absent' as const };
          }

          const runIds = new Set([rootRunId]);
          let cursor: string | undefined;
          do {
            const page = await storage.runs.list({
              pagination: { cursor, limit: 1000 },
              resolveData: 'none',
            });
            for (const run of page.data) {
              const selector = options?.descendantAttribute;
              if (
                selector !== undefined &&
                run.attributes[selector.key] === selector.value
              ) {
                runIds.add(run.runId);
              }
            }
            cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
          } while (cursor !== undefined);

          for (const runId of runIds) {
            const run = await storage.runs.get(runId, { resolveData: 'none' });
            if (run.status === 'pending' || run.status === 'running') {
              throw new EntityConflictError(
                `Workflow run tree ${rootRunId} is still active`
              );
            }
          }

          const manifest: PurgedTreeManifest = {
            rootRunId,
            runIds: [...runIds],
            ...(options?.descendantAttribute === undefined
              ? {}
              : { descendantAttribute: options.descendantAttribute }),
          };
          const manifestPath = taggedPath(
            mergedConfig.dataDir,
            'purged-trees',
            rootRunId,
            tag
          );
          await fs.mkdir(path.dirname(manifestPath), { recursive: true });
          await fs.writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest));
          await fs.rename(`${manifestPath}.tmp`, manifestPath);
          purgedTrees.set(rootRunId, manifest);
          for (const runId of runIds) purgedRuns.add(runId);
          await removeRunTreeEntities([...runIds]);
          return { purgedRunCount: runIds.size, status: 'purged' as const };

          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: exhaustively removes all backend entities
          async function removeRunTreeEntities(ids: string[]): Promise<void> {
            for (const runId of ids) {
              const hooks = [];
              let hookCursor: string | undefined;
              do {
                const page = await storage.hooks.list({
                  pagination: { cursor: hookCursor, limit: 1000 },
                  resolveData: 'all',
                  runId,
                });
                hooks.push(...page.data);
                hookCursor = page.hasMore
                  ? (page.cursor ?? undefined)
                  : undefined;
              } while (hookCursor !== undefined);
              const events = [];
              let eventCursor: string | undefined;
              do {
                const page = await storage.events.list({
                  pagination: { cursor: eventCursor, limit: 1000 },
                  resolveData: 'none',
                  runId,
                });
                events.push(...page.data);
                eventCursor = page.hasMore
                  ? (page.cursor ?? undefined)
                  : undefined;
              } while (eventCursor !== undefined);
              const steps = [];
              let stepCursor: string | undefined;
              do {
                const page = await storage.steps.list({
                  pagination: { cursor: stepCursor, limit: 1000 },
                  resolveData: 'none',
                  runId,
                });
                steps.push(...page.data);
                stepCursor = page.hasMore
                  ? (page.cursor ?? undefined)
                  : undefined;
              } while (stepCursor !== undefined);
              const streamNames = await streams.streams.list(runId);
              const byRunMarkers = await listHookByRunMarkers(
                mergedConfig.dataDir,
                runId
              );
              const hookCreatedEvents = events.filter(
                (event) => event.eventType === 'hook_created'
              );

              const waitsDir = path.join(mergedConfig.dataDir, 'waits');
              const waitFiles = (
                await fs.readdir(waitsDir).catch(() => [] as string[])
              )
                .filter(
                  (file) =>
                    file.startsWith(`${runId}-`) && file.endsWith('.json')
                )
                .map((file) => path.join(waitsDir, file));

              await Promise.all([
                ...hooks.flatMap((hook) => [
                  deleteJSON(
                    taggedPath(mergedConfig.dataDir, 'hooks', hook.hookId, tag)
                  ),
                  deleteJSON(
                    path.join(
                      mergedConfig.dataDir,
                      'hooks',
                      'tokens',
                      `${hashToken(hook.token)}.json`
                    )
                  ),
                  deleteJSON(
                    hookRecoveryMarkerPath(
                      mergedConfig.dataDir,
                      hook.token,
                      runId,
                      hook.hookId
                    )
                  ),
                  ...hookCreatedEvents
                    .filter((event) => event.correlationId === hook.hookId)
                    .flatMap((event) => [
                      deleteJSON(
                        taggedPath(
                          mergedConfig.dataDir,
                          `hooks/token-index/${hashToken(hook.token)}`,
                          event.eventId,
                          tag
                        )
                      ),
                      deleteJSON(
                        taggedPath(
                          mergedConfig.dataDir,
                          `hooks/id-index/${hook.hookId}`,
                          event.eventId,
                          tag
                        )
                      ),
                    ]),
                ]),
                ...byRunMarkers.map((marker) =>
                  deleteHookByRunMarkerFile(mergedConfig.dataDir, marker.fileId)
                ),
                ...waitFiles.map((file) => deleteJSON(file)),
                ...events.map((event) =>
                  deleteJSON(
                    taggedPath(
                      mergedConfig.dataDir,
                      'events',
                      `${runId}-${event.eventId}`,
                      tag
                    )
                  )
                ),
                ...steps.map((step) =>
                  deleteJSON(
                    taggedPath(mergedConfig.dataDir, 'steps', step.stepId, tag)
                  )
                ),
                ...streamNames.map((name) =>
                  rm(
                    path.join(mergedConfig.dataDir, 'streams', 'chunks', name),
                    {
                      force: true,
                      recursive: true,
                    }
                  )
                ),
                deleteJSON(
                  taggedPath(mergedConfig.dataDir, 'streams/runs', runId, tag)
                ),
                deleteJSON(
                  taggedPath(mergedConfig.dataDir, 'runs', runId, tag)
                ),
              ]);
            }
            clearStorageCache();
            resetHookIndexEnsureCache();
          }
        }
      );
    },
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
          'hooks/by-run',
          'waits',
          'streams/runs',
          'purged-trees',
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
          await Promise.all(
            keyDirEntries
              .filter((entry) => entry.isDirectory())
              .map(async (entry) => {
                const keyDir = path.join(fullIndexDir, entry.name);
                const taggedEntryFiles = await listTaggedFiles(keyDir, tag);
                await Promise.all(
                  taggedEntryFiles.map((f) => deleteJSON(path.join(keyDir, f)))
                );
              })
          );
        }
        // Clean up lock files used for atomic terminal-state guards
        await fs
          .rm(path.join(basedir, '.locks'), { recursive: true, force: true })
          .catch(() => {});
        // Delete tagged stream chunks (.{tag}.bin files). Chunks are sharded
        // one directory per stream (streams/chunks/<streamName>/<chunkId>.{tag}.bin),
        // so iterate each per-stream directory — the top-level chunks dir now
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
        await Promise.all(
          streamDirEntries
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
              const streamChunkDir = path.join(chunksDir, entry.name);
              const taggedBinFiles = await listTaggedFilesByExtension(
                streamChunkDir,
                tag,
                '.bin'
              );
              await Promise.all(
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
      purgedRuns.clear();
      purgedTrees.clear();
      purgeFencesLoaded = false;
    },
  };
}

/**
 * @deprecated Use `createWorld()` instead.
 */
export function createLocalWorld(args?: Partial<Config>): LocalWorld {
  return createWorld(args);
}
