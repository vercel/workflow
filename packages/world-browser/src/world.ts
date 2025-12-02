import type { World } from '@workflow/world';
import { createQueue } from './queue.js';
import { createSchema, type BrowserDatabase } from './schema.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

export interface BrowserWorldConfig {
  /**
   * Database path. Use ':memory:' for ephemeral in-memory database
   * or a filename like 'workflows.db' for OPFS persistence.
   * @default 'workflows.db'
   */
  database?: string;
}

/**
 * Creates a browser-based World instance using Turso WASM for storage.
 * This should be called from within a SharedWorker.
 */
export async function createBrowserWorld(
  config: BrowserWorldConfig = {}
): Promise<World & { db: BrowserDatabase; start(): Promise<void> }> {
  const dbPath = config.database ?? 'workflows.db';

  // Dynamic import to avoid issues during SSR
  // Use bundle import which has everything (including WASM and workers) inlined
  // @ts-expect-error - bundle export doesn't have type definitions
  const { connect } = await import('@tursodatabase/database-wasm/bundle');
  const db = await connect(dbPath);

  // Initialize schema
  await createSchema(db);

  const storage = createStorage(db);
  const queue = createQueue(db);
  const streamer = createStreamer(db);

  return {
    ...storage,
    ...queue,
    ...streamer,
    db,
    async start() {
      // Queue processor is started separately when workflows are registered
    },
  };
}
