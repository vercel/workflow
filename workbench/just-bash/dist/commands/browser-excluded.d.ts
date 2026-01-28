/**
 * List of commands that are not available in browser environments.
 *
 * These commands are excluded from the browser bundle because they:
 * - Use Node.js-specific APIs that don't have browser equivalents
 * - Have dependencies that don't work in browsers
 *
 * When a user tries to use one of these commands in a browser environment,
 * they should get a helpful error message explaining why the command
 * is not available.
 */
export declare const BROWSER_EXCLUDED_COMMANDS: readonly string[];
/**
 * Check if a command is browser-excluded
 */
export declare function isBrowserExcludedCommand(commandName: string): boolean;
