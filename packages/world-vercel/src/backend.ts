import type { Storage, Streamer } from '@workflow/world';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';
import type { APIConfig } from './utils.js';

export function createVercel(config?: APIConfig): Streamer & Storage {
  const storage = createStorage(config);
  const streamer = createStreamer(config);

  return {
    // Streamer interface
    writeToStream: streamer.writeToStream,
    closeStream: streamer.closeStream,
    readFromStream: streamer.readFromStream,
    listStreamsByRunId: streamer.listStreamsByRunId,

    // Storage interface with namespaced methods
    runs: storage.runs,
    steps: storage.steps,
    events: storage.events,
    hooks: storage.hooks,
  };
}
