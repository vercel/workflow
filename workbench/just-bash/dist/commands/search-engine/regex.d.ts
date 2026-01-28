/**
 * Regex building utilities for search commands
 */
export type RegexMode = "basic" | "extended" | "fixed" | "perl";
export interface RegexOptions {
    mode: RegexMode;
    ignoreCase?: boolean;
    wholeWord?: boolean;
    lineRegexp?: boolean;
    multiline?: boolean;
    /** Makes . match newlines in multiline mode (ripgrep --multiline-dotall) */
    multilineDotall?: boolean;
}
export interface RegexResult {
    regex: RegExp;
    /** If \K was used, this is the 1-based index of the capture group containing the "real" match */
    kResetGroup?: number;
}
/**
 * Build a JavaScript RegExp from a pattern with the specified mode
 */
export declare function buildRegex(pattern: string, options: RegexOptions): RegexResult;
/**
 * Convert replacement string syntax to JavaScript's String.replace format
 *
 * Conversions:
 * - $0 and ${0} -> $& (full match)
 * - $name -> $<name> (named capture groups)
 * - ${name} -> $<name> (braced named capture groups)
 * - Preserves $1, $2, etc. for numbered groups
 */
export declare function convertReplacement(replacement: string): string;
