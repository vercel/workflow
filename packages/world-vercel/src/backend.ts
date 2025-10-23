import type { AuthProvider, Storage, Streamer } from '@workflow/world';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';
import type { APIConfig } from './utils.js';

export function createVercel(
  config?: APIConfig
): Streamer & Storage & AuthProvider {
  const storage = createStorage(config);
  const streamer = createStreamer(config);

  return {
    // Streamer interface
    writeToStream: streamer.writeToStream,
    closeStream: streamer.closeStream,
    readFromStream: streamer.readFromStream,

    // AuthProvider interface
    getAuthInfo: storage.getAuthInfo,
    checkHealth: storage.checkHealth,

    // Storage interface with namespaced methods
    runs: storage.runs,
    steps: storage.steps,
    events: storage.events,
    hooks: storage.hooks,
  };
}
