import type { Limits, Queue, Storage } from '@workflow/world';
import { instrumentObject } from '../instrumentObject.js';
import { createEventsStorage } from './events-storage.js';
import { createHooksStorage } from './hooks-storage.js';
import { createRunsStorage } from './runs-storage.js';
import { createStepsStorage } from './steps-storage.js';

export interface LocalStorageOptions {
  limits?: Limits;
  queue?: Pick<Queue, 'queue'>;
}

/**
 * Creates a complete storage implementation using the filesystem.
 * This is the main entry point that composes all storage implementations.
 *
 * All storage methods are instrumented with tracing spans for observability.
 *
 * @param basedir - The base directory for storing workflow data
 * @returns A complete Storage implementation with tracing
 */
export function createStorage(
  basedir: string,
  tag?: string,
  options?: LocalStorageOptions
): Storage {
  const runs = createRunsStorage(basedir, tag);
  const storage: Storage = {
    runs,
    steps: createStepsStorage(basedir, tag),
    events: createEventsStorage(basedir, tag, {
      ...options,
      runs,
    }),
    hooks: createHooksStorage(basedir, tag),
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
