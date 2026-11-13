/**
 * Storage for workflow data in the data directory's SQLite database
 * (`<dataDir>/world.db`): runs, steps, events, hooks and snapshots.
 *
 * @module
 */

// Re-export from the modular storage implementation
export { createStorage } from './storage/index.js';
