import type { World } from '@workflow/world';
import type { Config } from './config.js';
import { config } from './config.js';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

/**
 * Creates an embedded world instance that combines queue, storage, and streamer functionalities.
 *
 * @param {Partial<Config>} args - The configuration to use for the embedded world.
 */
export function createEmbeddedWorld(args: Partial<Config>): World {
  const mergedConfig = { ...config.value, ...args };
  return {
    ...createQueue(mergedConfig),
    ...createStorage(mergedConfig.dataDir),
    ...createStreamer(mergedConfig.dataDir),
  };
}
