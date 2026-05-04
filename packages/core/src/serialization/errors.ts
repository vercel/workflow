/**
 * Shared error formatting utility for serialization failures.
 *
 * Used by the mode-specific serializers (workflow, step, client) to
 * produce consistent error messages with devalue path information.
 *
 * Returns a `{ message, hint }` pair so callers can throw a
 * `SerializationError(message, { hint, cause })` and have the hint flow
 * through the standard friendly-errors framing instead of being baked
 * into the message string.
 */

import { DevalueError } from 'devalue';
import { runtimeLogger } from '../logger.js';

/**
 * Format a serialization error with context about what failed.
 * Extracts path, value, and reason from devalue's DevalueError when available.
 * Logs the problematic value to the console for better debugging.
 */
export function formatSerializationError(
  context: string,
  error: unknown
): { message: string; hint: string } {
  // `returning` for outputs, `passing` for everything that crosses the
  // boundary the other way (arguments, stream messages, etc.).
  const verb = context.includes('return value') ? 'returning' : 'passing';
  let message = `Failed to serialize ${context}`;
  if (error instanceof DevalueError && error.path) {
    message += ` at path "${error.path}"`;
  }
  // Workflow can serialize a much richer set than the devalue defaults —
  // classes registered via `WORKFLOW_SERIALIZE`, FatalError / RetryableError
  // subclasses, AbortSignal, etc. Pointing at the foundations doc keeps
  // this hint accurate as the supported set grows, instead of repeating
  // a hardcoded list that drifts out of sync.
  const hint = `Ensure you're ${verb} workflow serializable types. Check the serialization docs to see what's serializable: https://workflow-sdk.dev/docs/foundations/serialization`;
  if (error instanceof DevalueError && error.value !== undefined) {
    runtimeLogger.error('Serialization failed', {
      context,
      problematicValue: error.value,
    });
  }
  return { message, hint };
}
