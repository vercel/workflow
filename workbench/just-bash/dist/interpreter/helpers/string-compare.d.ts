/**
 * String comparison helpers for conditionals.
 *
 * Consolidates string comparison logic (=, ==, !=) used in:
 * - [[ ]] conditional expressions (with optional pattern matching)
 * - test/[ ] command (literal comparison only)
 */
export type StringCompareOp = "=" | "==" | "!=";
/**
 * Check if an operator is a string comparison operator.
 */
export declare function isStringCompareOp(op: string): op is StringCompareOp;
/**
 * Compare two strings using the specified operator.
 *
 * @param op - The comparison operator (=, ==, !=)
 * @param left - Left operand
 * @param right - Right operand
 * @param usePattern - If true, use glob pattern matching for equality (default: false)
 * @param nocasematch - If true, use case-insensitive comparison (default: false)
 * @param extglob - If true, enable extended glob patterns @(), *(), +(), ?(), !() (default: false)
 * @returns True if the comparison succeeds
 */
export declare function compareStrings(op: StringCompareOp, left: string, right: string, usePattern?: boolean, nocasematch?: boolean, extglob?: boolean): boolean;
