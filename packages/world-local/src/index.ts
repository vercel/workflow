import { rm } from 'node:fs/promises';
import type { World } from '@workflow/world';
import type { Config } from './config.js';
import { config } from './config.js';
import { initDataDir } from './init.js';
import { createQueue, type DirectHandler } from './queue.js';
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

export {
  createQueueExecutor,
  type DirectHandler,
  type QueueExecutionRequest,
  type QueueExecutionResult,
  type QueueExecutor,
} from './queue.js';

export type LocalWorld = World & {
  /** Register a direct in-process handler for a queue prefix, bypassing HTTP. */
  registerHandler(
    prefix: '__wkf_step_' | '__wkf_workflow_',
    handler: DirectHandler
  ): void;
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
 * @throws {DataDirAccessError} If the data directory cannot be created or accessed
 * @throws {DataDirVersionError} If the data directory version is incompatible
 */
export function createLocalWorld(args?: Partial<Config>): LocalWorld {
  const definedArgs = args
    ? Object.fromEntries(
        Object.entries(args).filter(([, value]) => value !== undefined)
      )
    : {};
  const mergedConfig = { ...config.value, ...definedArgs };
  const queue = createQueue(mergedConfig);
  return {
    ...queue,
    ...createStorage(mergedConfig.dataDir),
    ...createStreamer(mergedConfig.dataDir),
    async start() {
      await initDataDir(mergedConfig.dataDir);
    },
    async close() {
      await queue.close();
    },
    async clear() {
      await rm(mergedConfig.dataDir, { recursive: true, force: true });
      await initDataDir(mergedConfig.dataDir);
    },
  };
}
