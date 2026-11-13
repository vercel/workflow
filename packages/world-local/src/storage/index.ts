import type { Storage } from '@workflow/world';
import { databaseFor } from '../db/index.js';
import { instrumentObject } from '../instrumentObject.js';
import { createEventsStorage } from './events-storage.js';
import { createHooksStorage } from './hooks-storage.js';
import { createRunsStorage, type LocalRunsStorage } from './runs-storage.js';
import { createSnapshotsStorage } from './snapshots-storage.js';
import { createStepsStorage } from './steps-storage.js';

/**
 * Storage shape used inside world-local: identical to `Storage`, but `runs`
 * exposes the internal `ownTagOnly` option on `list()`. Structurally
 * assignable to `Storage` at public boundaries (e.g., `reenqueueActiveRuns`).
 */
export type LocalStorage = Omit<Storage, 'runs'> & {
  runs: LocalRunsStorage;
  clearCache(): void;
};

/**
 * Creates world-local's storage over the data directory's SQLite database
 * (`<dataDir>/world.db`). All methods are instrumented with tracing spans.
 *
 * @param basedir - The data directory
 * @param tag - Optional tag scoping the runs this storage creates and sees
 */
export function createStorage(basedir: string, tag?: string): LocalStorage {
  const db = databaseFor(basedir);
  const runs = createRunsStorage(db, tag);
  const steps = createStepsStorage(db, tag);
  const events = createEventsStorage(db, tag);
  const hooks = createHooksStorage(db, tag);
  const snapshots = createSnapshotsStorage(db);

  // NOTE: Span names are lowercase per OTEL semantic conventions
  return {
    runs: instrumentObject('world.runs', runs),
    steps: instrumentObject('world.steps', steps),
    events: instrumentObject('world.events', events),
    hooks: instrumentObject('world.hooks', hooks),
    experimental_snapshots: instrumentObject(
      'world.experimental_snapshots',
      snapshots
    ),
    clearCache: () => {},
  };
}
