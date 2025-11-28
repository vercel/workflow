import { contextStorage } from './context-storage.js';

/**
 * Returns the closure variables for the current step function.
 * This is an internal function used by the SWC transform to access
 * variables from the parent workflow scope.
 *
 * @internal
 */
export function __private_getClosureVars(): Record<string, any> {
  const ctx = contextStorage.getStore();
  if (!ctx) {
    throw new Error(
      'Closure variables can only be accessed inside a step function'
    );
  }
  return ctx.closureVars || {};
}
