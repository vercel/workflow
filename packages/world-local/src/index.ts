import type { World } from '@workflow/world';
import { auth } from './auth.js';
import { config } from './config.js';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

/**
 * Creates an embedded world instance that combines queue, storage, streamer, and authentication functionalities.
 *
 * @param dataDir - The directory to use for storage. If not provided, the default data dir will be used.
 * @param port - The port to use for the queue. If not provided, the default port will be used.
 */
export function createEmbeddedWorld({
  dataDir,
  port,
}: {
  dataDir?: string;
  port?: number;
}): World {
  const dir = dataDir ?? config.value.dataDir;
  const queuePort = port ?? config.value.port;
  return {
    ...createQueue(queuePort),
    ...createStorage(dir),
    ...createStreamer(dir),
    ...auth,
  };
}
