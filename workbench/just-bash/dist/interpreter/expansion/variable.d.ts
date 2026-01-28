/**
 * Variable Access
 *
 * Handles variable value retrieval, including:
 * - Special variables ($?, $$, $#, $@, $*, $0)
 * - Array access (${arr[0]}, ${arr[@]}, ${arr[*]})
 * - Positional parameters ($1, $2, ...)
 * - Regular variables
 * - Nameref resolution
 */
import type { InterpreterContext } from "../types.js";
/**
 * Get all elements of an array stored as arrayName_0, arrayName_1, etc.
 * Returns an array of [index/key, value] tuples, sorted by index/key.
 * For associative arrays, uses string keys.
 * Special arrays FUNCNAME, BASH_LINENO, and BASH_SOURCE are handled dynamically from call stack.
 */
export declare function getArrayElements(ctx: InterpreterContext, arrayName: string): Array<[number | string, string]>;
/**
 * Check if a variable is an array (has elements stored as name_0, name_1, etc.)
 */
export declare function isArray(ctx: InterpreterContext, name: string): boolean;
/**
 * Get the value of a variable, optionally checking nounset.
 * @param ctx - The interpreter context
 * @param name - The variable name
 * @param checkNounset - Whether to check for nounset (default true)
 */
export declare function getVariable(ctx: InterpreterContext, name: string, checkNounset?: boolean, _insideDoubleQuotes?: boolean): Promise<string>;
/**
 * Check if a variable is set (exists in the environment).
 * Properly handles array subscripts (e.g., arr[0] -> arr_0).
 * @param ctx - The interpreter context
 * @param name - The variable name (possibly with array subscript)
 */
export declare function isVariableSet(ctx: InterpreterContext, name: string): Promise<boolean>;
