/**
 * Brace Range Expansion
 *
 * Handles numeric {1..10} and character {a..z} range expansion.
 * These are pure functions with no external dependencies.
 */
/**
 * Result of a brace range expansion.
 * Either contains expanded values or a literal fallback for invalid ranges.
 */
export interface BraceRangeResult {
    expanded: string[] | null;
    literal: string;
}
/**
 * Unified brace range expansion helper.
 * Handles both numeric and character ranges, returning either expanded values
 * or a literal string for invalid ranges.
 */
export declare function expandBraceRange(start: number | string, end: number | string, step: number | undefined, startStr?: string, endStr?: string): BraceRangeResult;
