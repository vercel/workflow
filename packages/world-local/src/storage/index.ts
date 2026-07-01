import type { Storage } from '@workflow/world';
import { instrumentObject } from '../instrumentObject.js';
import { createEventsStorage } from './events-storage.js';
import { createHooksStorage } from './hooks-storage.js';
import { createRunsStorage, type LocalRunsStorage } from './runs-storage.js';
import { createStepsStorage } from './steps-storage.js';

/**
 * Storage shape used inside world-local: identical to `Storage`, but `runs`
 * exposes the internal `fileIdFilter` option on `list()`. Structurally
 * assignable to `Storage` at public boundaries (e.g., `reenqueueActiveRuns`).
 */
export type LocalStorage = Omit<Storage, 'runs'> & {
  runs: LocalRunsStorage;
  clearCache(): void;
};

/**
 * Creates a complete storage implementation using the filesystem.
 * This is the main entry point that composes all storage implementations.
 *
 * All storage methods are instrumented with tracing spans for observability.
 *
 * @param basedir - The base directory for storing workflow data
 * @returns A complete Storage implementation with tracing
 */
export function createStorage(basedir: string, tag?: string): LocalStorage {
  // Create raw storage implementations
  const runs = createRunsStorage(basedir, tag);
  const steps = createStepsStorage(basedir, tag);
  const events = createEventsStorage(basedir, tag);
  const hooks = createHooksStorage(basedir, tag);

  // Instrument all storage methods with tracing
  // NOTE: Span names are lowercase per OTEL semantic conventions
  return {
    runs: instrumentObject('world.runs', runs),
    steps: instrumentObject('world.steps', steps),
    events: instrumentObject('world.events', events),
    hooks: instrumentObject('world.hooks', hooks),
    clearCache: () => events.clearCache(),
  };
}
