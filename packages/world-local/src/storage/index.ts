import type { Storage } from '@workflow/world';
import { instrumentObject } from '../instrumentObject.js';
import { createEventsStorage } from './events-storage.js';
import { createHooksStorage } from './hooks-storage.js';
import { createRunsStorage } from './runs-storage.js';
import { createStepsStorage } from './steps-storage.js';

/**
 * Creates a complete storage implementation using the filesystem.
 * This is the main entry point that composes all storage implementations.
 *
 * All storage methods are instrumented with tracing spans for observability.
 *
 * @param basedir - The base directory for storing workflow data
 * @returns A complete Storage implementation with tracing
 */
export function createStorage(basedir: string): Storage {
  // Create raw storage implementations
  const storage: Storage = {
    runs: createRunsStorage(basedir),
    steps: createStepsStorage(basedir),
    events: createEventsStorage(basedir),
    hooks: createHooksStorage(basedir),
  };

  // Instrument all storage methods with tracing
  // NOTE: Span names are lowercase per OTEL semantic conventions
  return {
    runs: instrumentObject('world.runs', storage.runs),
    steps: instrumentObject('world.steps', storage.steps),
    events: instrumentObject('world.events', storage.events),
    hooks: instrumentObject('world.hooks', storage.hooks),
  };
}
