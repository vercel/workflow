import type { InterpreterContext } from "../types.js";
/**
 * Evaluates the -v (variable is set) test.
 * Handles both simple variables and array element access with negative indices.
 *
 * @param ctx - Interpreter context with environment variables
 * @param operand - The variable name to test, may include array subscript (e.g., "arr[0]", "arr[-1]")
 */
export declare function evaluateVariableTest(ctx: InterpreterContext, operand: string): Promise<boolean>;
