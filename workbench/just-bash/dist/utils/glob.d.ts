/**
 * Shared glob pattern matching utilities.
 *
 * Used by grep, find, and other commands that need glob matching.
 */
export interface MatchGlobOptions {
    /** Case-insensitive matching */
    ignoreCase?: boolean;
    /** Strip surrounding quotes from pattern before matching */
    stripQuotes?: boolean;
}
/**
 * Match a filename against a glob pattern.
 *
 * Supports:
 * - `*` matches any sequence of characters
 * - `?` matches any single character
 * - `[...]` character classes
 *
 * @param name - The filename to test
 * @param pattern - The glob pattern
 * @param options - Matching options
 * @returns true if the name matches the pattern
 */
export declare function matchGlob(name: string, pattern: string, options?: MatchGlobOptions | boolean): boolean;
