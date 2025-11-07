import type { World } from '@workflow/world';
import type { Config } from './config.js';
import { config } from './config.js';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

/**
 * Creates an embedded world instance that combines queue, storage, and streamer functionalities.
 *
 * @param args - Optional configuration object
 * @param args.dataDir - Directory for storing workflow data (default: `.workflow-data/`)
 * @param args.port - Port override for queue transport (default: auto-detected)
 * @param args.baseUrl - Full base URL override for queue transport (default: `http://localhost:{port}`)
 */
export function createEmbeddedWorld(args?: Partial<Config>): World {
  const mergedConfig = { ...config.value, ...(args ?? {}) };
  return {
    ...createQueue(mergedConfig),
    ...createStorage(mergedConfig.dataDir),
    ...createStreamer(mergedConfig.dataDir),
  };
}
