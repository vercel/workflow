/**
 * String comparison helpers for conditionals.
 *
 * Consolidates string comparison logic (=, ==, !=) used in:
 * - [[ ]] conditional expressions (with optional pattern matching)
 * - test/[ ] command (literal comparison only)
 */
import { matchPattern } from "../conditionals.js";
/**
 * Check if an operator is a string comparison operator.
 */
export function isStringCompareOp(op) {
    return op === "=" || op === "==" || op === "!=";
}
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
export function compareStrings(op, left, right, usePattern = false, nocasematch = false, extglob = false) {
    if (usePattern) {
        const isEqual = matchPattern(left, right, nocasematch, extglob);
        return op === "!=" ? !isEqual : isEqual;
    }
    if (nocasematch) {
        const isEqual = left.toLowerCase() === right.toLowerCase();
        return op === "!=" ? !isEqual : isEqual;
    }
    const isEqual = left === right;
    return op === "!=" ? !isEqual : isEqual;
}
