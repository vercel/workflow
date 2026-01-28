/**
 * Numeric comparison helper for conditionals.
 * Handles -eq, -ne, -lt, -le, -gt, -ge operators.
 */
export type NumericOp = "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge";
/**
 * Check if an operator is a numeric comparison operator.
 */
export declare function isNumericOp(op: string): op is NumericOp;
/**
 * Compare two numbers using a numeric comparison operator.
 */
export declare function compareNumeric(op: NumericOp, left: number, right: number): boolean;
