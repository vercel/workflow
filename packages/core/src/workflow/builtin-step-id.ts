import { version } from '../version.js';

/**
 * Construct a step ID for a built-in function from workflow/internal/builtins.
 * These IDs must match what the SWC plugin generates when processing the
 * builtins file as a standard "use step" function.
 *
 * Format: step//workflow/internal/builtins@{version}//{fnName}
 */
export function builtinStepId(fnName: string): string {
  return `step//workflow/internal/builtins@${version}//${fnName}`;
}
