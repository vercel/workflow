/**
 * Regex conversion utilities for sed command
 */
/**
 * Convert Basic Regular Expression (BRE) to Extended Regular Expression (ERE).
 * In BRE: +, ?, |, (, ) are literal; \+, \?, \|, \(, \) are special
 * In ERE: +, ?, |, (, ) are special; \+, \?, \|, \(, \) are literal
 * Also converts POSIX character classes to JavaScript equivalents.
 */
export declare function breToEre(pattern: string): string;
/**
 * Normalize regex patterns for JavaScript RegExp.
 * Converts GNU sed extensions to JavaScript-compatible syntax.
 *
 * Handles:
 * - {,n} → {0,n} (GNU extension: "0 to n times")
 */
export declare function normalizeForJs(pattern: string): string;
/**
 * Escape pattern space for the `l` (list) command.
 * Shows non-printable characters as escape sequences and ends with $.
 */
export declare function escapeForList(input: string): string;
