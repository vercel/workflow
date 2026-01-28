/**
 * Quoting helpers for word expansion
 *
 * Handles quoting values for shell reuse (${var@Q} transformation).
 */
/**
 * Quote a value for safe reuse as shell input (${var@Q} transformation)
 * Uses single quotes with proper escaping for special characters.
 * Follows bash's quoting behavior:
 * - Simple strings without quotes: 'value'
 * - Strings with single quotes or control characters: $'value' with \' escaping
 */
export declare function quoteValue(value: string): string;
