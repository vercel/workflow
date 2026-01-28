/**
 * Numeric comparison helper for conditionals.
 * Handles -eq, -ne, -lt, -le, -gt, -ge operators.
 */
const NUMERIC_OPS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
/**
 * Check if an operator is a numeric comparison operator.
 */
export function isNumericOp(op) {
    return NUMERIC_OPS.has(op);
}
/**
 * Compare two numbers using a numeric comparison operator.
 */
export function compareNumeric(op, left, right) {
    switch (op) {
        case "-eq":
            return left === right;
        case "-ne":
            return left !== right;
        case "-lt":
            return left < right;
        case "-le":
            return left <= right;
        case "-gt":
            return left > right;
        case "-ge":
            return left >= right;
    }
}
