import type { World } from '@workflow/world';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';
import type { APIConfig } from './utils.js';

export { createQueue } from './queue.js';
export { createStorage } from './storage.js';
export { createStreamer } from './streamer.js';
export type { APIConfig } from './utils.js';

export function createVercelWorld(config?: APIConfig): World {
  return {
    ...createQueue(config),
    ...createStorage(config),
    ...createStreamer(config),
  };
}
