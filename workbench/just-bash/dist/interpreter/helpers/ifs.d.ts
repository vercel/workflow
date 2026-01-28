/**
 * IFS (Internal Field Separator) Handling
 *
 * Centralized utilities for IFS-based word splitting used by:
 * - Word expansion (unquoted variable expansion)
 * - read builtin
 * - ${!prefix*} and ${!arr[*]} expansions
 */
/**
 * Get the effective IFS value from environment.
 * Returns DEFAULT_IFS if IFS is undefined, or the actual value (including empty string).
 */
export declare function getIfs(env: Record<string, string>): string;
/**
 * Check if IFS is set to empty string (disables word splitting).
 */
export declare function isIfsEmpty(env: Record<string, string>): boolean;
/**
 * Check if IFS contains only whitespace characters (space, tab, newline).
 * This affects how empty fields are handled in $@ and $* expansion.
 * When IFS has non-whitespace chars, empty params are preserved.
 * When IFS has only whitespace, empty params are dropped.
 */
export declare function isIfsWhitespaceOnly(env: Record<string, string>): boolean;
/**
 * Build a regex-safe pattern from IFS characters for use in character classes.
 * E.g., for IFS=" \t\n", returns " \\t\\n" (escaped for [pattern] use)
 */
export declare function buildIfsCharClassPattern(ifs: string): string;
/**
 * Get the first character of IFS (used for joining with $* and ${!prefix*}).
 * Returns space if IFS is undefined, empty string if IFS is empty.
 */
export declare function getIfsSeparator(env: Record<string, string>): string;
/**
 * Advanced IFS splitting for the read builtin with proper whitespace/non-whitespace handling.
 *
 * IFS has two types of characters:
 * - Whitespace (space, tab, newline): Multiple consecutive ones are collapsed,
 *   leading/trailing are stripped
 * - Non-whitespace (like 'x', ':'): Create empty fields when consecutive,
 *   trailing ones preserved (except the final delimiter)
 *
 * @param value - String to split
 * @param ifs - IFS characters to split on
 * @param maxSplit - Maximum number of splits (for read with multiple vars, the last gets the rest)
 * @param raw - If true, backslash escaping is disabled (like read -r)
 * @returns Object with words array and wordStarts array
 */
export declare function splitByIfsForRead(value: string, ifs: string, maxSplit?: number, raw?: boolean): {
    words: string[];
    wordStarts: number[];
};
/**
 * IFS splitting for word expansion (unquoted $VAR, $*, etc.).
 *
 * Key differences from splitByIfsForRead:
 * - Trailing non-whitespace delimiter does NOT create an empty field
 * - No maxSplit concept (always splits fully)
 * - No backslash escape handling
 *
 * @param value - String to split
 * @param ifs - IFS characters to split on
 * @returns Array of words after splitting
 */
/**
 * Result of splitByIfsForExpansionEx with leading/trailing delimiter info.
 */
export interface IfsExpansionSplitResult {
    words: string[];
    /** True if the value started with an IFS whitespace delimiter (affects joining with preceding text) */
    hadLeadingDelimiter: boolean;
    /** True if the value ended with an IFS delimiter (affects joining with subsequent text) */
    hadTrailingDelimiter: boolean;
}
/**
 * Extended IFS splitting that tracks trailing delimiters.
 * This is needed for proper word boundary handling when literal text follows an expansion.
 * For example, in `-$x-` where `x='a b c '`, the trailing space means the final `-`
 * should become a separate word, not join with `c`.
 */
export declare function splitByIfsForExpansionEx(value: string, ifs: string): IfsExpansionSplitResult;
export declare function splitByIfsForExpansion(value: string, ifs: string): string[];
/**
 * Strip trailing IFS from the last variable in read builtin.
 *
 * Bash behavior:
 * 1. Strip trailing IFS whitespace characters (but NOT if they're escaped by backslash)
 * 2. If there's a single trailing IFS non-whitespace character, strip it ONLY IF
 *    there are no other non-ws IFS chars in the content (excluding the trailing one)
 *
 * Examples with IFS="x ":
 * - "ax  " -> "a" (trailing spaces stripped, then trailing single x stripped because no other x)
 * - "ax" -> "a" (trailing single x stripped because no other x in remaining content)
 * - "axx" -> "axx" (two trailing x's, so don't strip - there's another x)
 * - "ax  x" -> "ax  x" (trailing x NOT stripped because there's an x earlier)
 * - "bx" -> "b" (trailing x stripped, no other x)
 * - "a\ " -> "a " (backslash-escaped space is NOT stripped)
 *
 * @param value - String to strip (raw, before backslash processing)
 * @param ifs - IFS characters
 * @param raw - If true, backslash escaping is disabled
 */
export declare function stripTrailingIfsWhitespace(value: string, ifs: string, raw?: boolean): string;
