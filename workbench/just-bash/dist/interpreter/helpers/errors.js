/**
 * Error helper functions for the interpreter.
 */
/**
 * Extract message from an unknown error value.
 * Handles both Error instances and other thrown values.
 */
export function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
