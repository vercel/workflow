/**
 * String test helper for conditionals.
 * Handles -z (empty) and -n (non-empty) operators.
 */
export type StringTestOp = "-z" | "-n";
/**
 * Check if an operator is a string test operator.
 */
export declare function isStringTestOp(op: string): op is StringTestOp;
/**
 * Evaluate a string test operator.
 */
export declare function evaluateStringTest(op: StringTestOp, value: string): boolean;
