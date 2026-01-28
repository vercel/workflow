/**
 * AWK Variable and Array Operations
 *
 * Handles user variables, built-in variables, and arrays.
 */
import type { AwkRuntimeContext } from "./context.js";
import type { AwkValue } from "./types.js";
/**
 * Get a variable value. Handles built-in variables.
 */
export declare function getVariable(ctx: AwkRuntimeContext, name: string): AwkValue;
/**
 * Set a variable value. Handles built-in variables with special behavior.
 */
export declare function setVariable(ctx: AwkRuntimeContext, name: string, value: AwkValue): void;
/**
 * Get an array element value.
 */
export declare function getArrayElement(ctx: AwkRuntimeContext, array: string, key: string): AwkValue;
/**
 * Set an array element value.
 */
export declare function setArrayElement(ctx: AwkRuntimeContext, array: string, key: string, value: AwkValue): void;
/**
 * Check if an array element exists.
 */
export declare function hasArrayElement(ctx: AwkRuntimeContext, array: string, key: string): boolean;
/**
 * Delete an array element.
 */
export declare function deleteArrayElement(ctx: AwkRuntimeContext, array: string, key: string): void;
/**
 * Delete an entire array.
 */
export declare function deleteArray(ctx: AwkRuntimeContext, array: string): void;
