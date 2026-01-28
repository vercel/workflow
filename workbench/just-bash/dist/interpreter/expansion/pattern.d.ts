/**
 * Pattern Matching
 *
 * Converts shell glob patterns to regex equivalents for pattern matching
 * in parameter expansion (${var%pattern}, ${var/pattern/replacement}, etc.)
 * and case statements.
 *
 * ## Error Handling
 *
 * This module follows bash's behavior for invalid patterns:
 * - Invalid character ranges (e.g., `[z-a]`) result in regex compilation failure
 * - Unknown POSIX classes (e.g., `[:foo:]`) produce empty match groups
 * - Unclosed character classes (`[abc`) are treated as literal `[`
 *
 * Callers should wrap regex compilation in try/catch to handle invalid patterns.
 */
/**
 * Convert a shell glob pattern to a regex string.
 * @param pattern - The glob pattern (*, ?, [...])
 * @param greedy - Whether * should be greedy (true for suffix matching, false for prefix)
 * @param extglob - Whether to support extended glob patterns (@(...), *(...), +(...), ?(...), !(...))
 */
export declare function patternToRegex(pattern: string, greedy: boolean, extglob?: boolean): string;
