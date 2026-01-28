/**
 * Shell value quoting utilities
 *
 * Provides functions for quoting values in shell output format,
 * used by both `set` and `declare/typeset` builtins.
 */
/**
 * Quote a value for shell output (used by 'set' and 'typeset' with no args)
 * Matches bash's output format:
 * - No quotes for simple alphanumeric values
 * - Single quotes for values with spaces or shell metacharacters
 * - $'...' quoting for values with control characters
 */
export declare function quoteValue(value: string): string;
/**
 * Quote a value for array element output
 * Uses $'...' for control characters, double quotes otherwise
 */
export declare function quoteArrayValue(value: string): string;
/**
 * Quote a value for declare -p output
 * Uses $'...' for control characters, double quotes otherwise
 */
export declare function quoteDeclareValue(value: string): string;
