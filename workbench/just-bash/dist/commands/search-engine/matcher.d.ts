/**
 * Core content matching logic for search commands
 */
export interface SearchOptions {
    /** Select non-matching lines */
    invertMatch?: boolean;
    /** Print line number with output lines */
    showLineNumbers?: boolean;
    /** Print only a count of matching lines */
    countOnly?: boolean;
    /** Count individual matches instead of lines (--count-matches) */
    countMatches?: boolean;
    /** Filename prefix for output (empty string for no prefix) */
    filename?: string;
    /** Show only the matching parts of lines */
    onlyMatching?: boolean;
    /** Print NUM lines of leading context */
    beforeContext?: number;
    /** Print NUM lines of trailing context */
    afterContext?: number;
    /** Stop after NUM matches (0 = unlimited) */
    maxCount?: number;
    /** Separator between context groups (default: --) */
    contextSeparator?: string;
    /** Show column number of first match */
    showColumn?: boolean;
    /** Output each match separately (vimgrep format) */
    vimgrep?: boolean;
    /** Show byte offset of each match */
    showByteOffset?: boolean;
    /** Replace matched text with this string */
    replace?: string | null;
    /** Print all lines (matches use :, non-matches use -) */
    passthru?: boolean;
    /** Enable multiline matching (patterns can span lines) */
    multiline?: boolean;
    /** If \K was used, this is the capture group index containing the "real" match */
    kResetGroup?: number;
}
export interface SearchResult {
    /** The formatted output string */
    output: string;
    /** Whether any matches were found */
    matched: boolean;
    /** Number of matches found */
    matchCount: number;
}
/**
 * Search content for regex matches and format output
 *
 * Handles:
 * - Count only mode (-c)
 * - Line numbers (-n)
 * - Invert match (-v)
 * - Only matching (-o)
 * - Context lines (-A, -B, -C)
 * - Max count (-m)
 */
export declare function searchContent(content: string, regex: RegExp, options?: SearchOptions): SearchResult;
