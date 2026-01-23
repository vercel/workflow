import type { Storage } from '@workflow/world';
import { createEventsStorage } from './events-storage.js';
import { createHooksStorage } from './hooks-storage.js';
import { createRunsStorage } from './runs-storage.js';
import { createStepsStorage } from './steps-storage.js';

/**
 * Creates a complete storage implementation using the filesystem.
 * This is the main entry point that composes all storage implementations.
 *
 * @param basedir - The base directory for storing workflow data
 * @returns A complete Storage implementation
 */
export function createStorage(basedir: string): Storage {
  return {
    runs: createRunsStorage(basedir),
    steps: createStepsStorage(basedir),
    events: createEventsStorage(basedir),
    hooks: createHooksStorage(basedir),
  };
}
