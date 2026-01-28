/**
 * String test helper for conditionals.
 * Handles -z (empty) and -n (non-empty) operators.
 */
const STRING_TEST_OPS = new Set(["-z", "-n"]);
/**
 * Check if an operator is a string test operator.
 */
export function isStringTestOp(op) {
    return STRING_TEST_OPS.has(op);
}
/**
 * Evaluate a string test operator.
 */
export function evaluateStringTest(op, value) {
    switch (op) {
        case "-z":
            return value === "";
        case "-n":
            return value !== "";
    }
}
