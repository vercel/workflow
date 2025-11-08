import type { World } from '@workflow/world';
import { config } from './config.js';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

/**
 * Creates an embedded world instance that combines queue, storage, and streamer functionalities.
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
  const queue = createQueue(queuePort);
  const getUrl = () => {
    const resolvedPort = queue.getResolvedPort?.() ?? queuePort;
    if (resolvedPort === undefined) {
      throw new Error(
        'Port is not available. Ensure a port is specified or the server is running.'
      );
    }
    return `http://localhost:${resolvedPort}`;
  };
  return {
    getUrl,
    ...queue,
    ...createStorage(dir),
    ...createStreamer(dir),
  };
}
