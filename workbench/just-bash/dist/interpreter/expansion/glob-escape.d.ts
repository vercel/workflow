/**
 * Glob Helper Functions
 *
 * Functions for handling glob patterns, escaping, and unescaping.
 */
/**
 * Check if a string contains glob patterns, including extglob when enabled.
 */
export declare function hasGlobPattern(value: string, extglob: boolean): boolean;
/**
 * Unescape a glob pattern - convert escaped glob chars to literal chars.
 * For example, [\]_ (escaped pattern) becomes [\\]_ (literal string).
 *
 * This is used when we need to take a pattern that was built with escaped
 * glob characters and convert it back to a literal string (e.g., for
 * no-match fallback when nullglob is off).
 *
 * Note: The input is expected to be a pattern string where backslashes escape
 * the following character. For patterns like "test\\[*" (user input: test\[*)
 * the output is "\\_" (with processed escapes), not [\\]_ (raw pattern).
 */
export declare function unescapeGlobPattern(pattern: string): string;
/**
 * Escape glob metacharacters in a string for literal matching.
 * Includes extglob metacharacters: ( ) |
 */
export declare function escapeGlobChars(str: string): string;
/**
 * Escape regex metacharacters in a string for literal matching.
 * Used when quoted patterns are used with =~ operator.
 */
export declare function escapeRegexChars(str: string): string;
