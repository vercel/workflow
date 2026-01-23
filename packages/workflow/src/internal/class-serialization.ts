/**
 * Class serialization utilities for the workflow compiler.
 *
 * This module is separate from private.ts to avoid pulling in Node.js-only
 * dependencies (like async_hooks) when used in workflow bundles.
 */

export * from '@workflow/core/class-serialization';
