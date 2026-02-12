/**
 * @deprecated Import from '@workflow/core/serialization-format' instead.
 *
 * This module is kept only as a re-export shim for backwards compatibility.
 * All types, classes, and functions have been moved to serialization-format.ts
 * which is browser-safe (no Node.js dependencies).
 *
 * Environment-specific hydration lives in:
 * - Web: @workflow/web-shared (lib/hydration.ts)
 * - CLI: @workflow/cli (lib/inspect/hydration.ts)
 */

export {
  CLASS_INSTANCE_REF_TYPE,
  ClassInstanceRef,
  // Utilities
  extractStreamIds,
  // Hydration (generic, requires revivers parameter)
  hydrateData,
  hydrateResourceIO,
  // Type guards
  isClassInstanceRef,
  isStreamId,
  isStreamRef,
  observabilityRevivers,
  type Revivers,
  STREAM_REF_TYPE,
  // Types and classes
  type StreamRef,
  truncateId,
} from './serialization-format.js';
