/**
 * Declare Print Mode Functions
 *
 * Handles printing and listing variables for the declare/typeset builtin.
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
/**
 * Print specific variables with their declarations.
 * Handles: declare -p varname1 varname2 ...
 */
export declare function printSpecificVariables(ctx: InterpreterContext, names: string[]): ExecResult;
export interface PrintAllFilters {
    filterExport: boolean;
    filterReadonly: boolean;
    filterNameref: boolean;
    filterIndexedArray: boolean;
    filterAssocArray: boolean;
}
/**
 * Print all variables with their declarations and attributes.
 * Handles: declare -p (with optional filters like -x, -r, -n, -a, -A)
 */
export declare function printAllVariables(ctx: InterpreterContext, filters: PrintAllFilters): ExecResult;
/**
 * List all associative arrays.
 * Handles: declare -A (without arguments)
 */
export declare function listAssociativeArrays(ctx: InterpreterContext): ExecResult;
/**
 * List all indexed arrays.
 * Handles: declare -a (without arguments)
 */
export declare function listIndexedArrays(ctx: InterpreterContext): ExecResult;
/**
 * List all variables without print mode (no attributes shown).
 * Handles: declare (without -p and without arguments)
 */
export declare function listAllVariables(ctx: InterpreterContext): ExecResult;
