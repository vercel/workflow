/**
 * Filesystem-based storage implementation for workflow data.
 *
 * This module provides a complete Storage implementation that persists
 * workflow runs, steps, events, and hooks to the local filesystem.
 *
 * @module
 */

// Re-export from the modular storage implementation
export { createStorage } from './storage/index.js';
