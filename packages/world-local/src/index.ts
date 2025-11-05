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
 * @param baseUrl - The base URL to use for the queue. Takes priority over port if provided.
 */
export function createEmbeddedWorld({
  dataDir,
  port,
  baseUrl,
}: {
  dataDir?: string;
  port?: number;
  baseUrl?: string;
}): World {
  const dir = dataDir ?? config.value.dataDir;

  // TODO: confirm with Gal on priority. Current Priority - baseUrl parameter > config baseUrl > port parameter > config port > default 3000
  const queueBaseUrl =
    baseUrl ?? config.value.baseUrl ?? port ?? config.value.port;

  const finalUrl =
    typeof queueBaseUrl === 'string'
      ? queueBaseUrl
      : `http://localhost:${queueBaseUrl}`;

  return {
    ...createQueue(finalUrl),
    ...createStorage(dir),
    ...createStreamer(dir),
  };
}
