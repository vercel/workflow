/**
 * Glob Helper Functions
 *
 * Pure helper functions for glob pattern parsing and regex conversion.
 */
/**
 * Convert POSIX character class name to regex equivalent
 */
export declare function posixClassToRegex(className: string): string;
/**
 * Split GLOBIGNORE value on colons, but preserve colons inside POSIX character classes.
 * For example: "[[:alnum:]]*:*.txt" should split to ["[[:alnum:]]*", "*.txt"]
 * not ["[[:alnum", "]]*", "*.txt"]
 */
export declare function splitGlobignorePatterns(globignore: string): string[];
/**
 * Convert a GLOBIGNORE pattern to a RegExp.
 * Unlike regular glob patterns, * does NOT match /.
 */
export declare function globignorePatternToRegex(pattern: string): RegExp;
/**
 * Find the matching closing parenthesis, handling nesting
 */
export declare function findMatchingParen(pattern: string, openIdx: number): number;
/**
 * Split extglob pattern content on | handling nested patterns and quotes.
 * Single-quoted content is preserved with a special marker for later processing.
 */
export declare function splitExtglobAlternatives(content: string): string[];
