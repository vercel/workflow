/**
 * Shared error formatting utility for serialization failures.
 *
 * Used by the mode-specific serializers (workflow, step, client) to
 * produce consistent error messages with devalue path information.
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
): string {
  const verb = context.includes('return value') ? 'returning' : 'passing';
  let message = `Failed to serialize ${context}`;
  if (error instanceof DevalueError && error.path) {
    message += ` at path "${error.path}"`;
  }
  message += `. Ensure you're ${verb} serializable types (plain objects, arrays, primitives, Date, RegExp, Map, Set).`;
  if (error instanceof DevalueError && error.value !== undefined) {
    runtimeLogger.error('Serialization failed', {
      context,
      problematicValue: error.value,
    });
  }
  return message;
}
