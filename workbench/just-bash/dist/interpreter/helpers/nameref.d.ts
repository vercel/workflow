/**
 * Nameref (declare -n) support
 *
 * Namerefs are variables that reference other variables by name.
 * When a nameref is accessed, it transparently dereferences to the target variable.
 */
import type { InterpreterContext } from "../types.js";
/**
 * Check if a variable is a nameref
 */
export declare function isNameref(ctx: InterpreterContext, name: string): boolean;
/**
 * Mark a variable as a nameref
 */
export declare function markNameref(ctx: InterpreterContext, name: string): void;
/**
 * Remove the nameref attribute from a variable
 */
export declare function unmarkNameref(ctx: InterpreterContext, name: string): void;
/**
 * Mark a nameref as having an "invalid" target at creation time.
 * Invalid namerefs always read/write their value directly, never resolving.
 */
export declare function markNamerefInvalid(ctx: InterpreterContext, name: string): void;
/**
 * Mark a nameref as "bound" - meaning its target existed at creation time.
 * This is kept for tracking purposes but is currently not used in resolution.
 */
export declare function markNamerefBound(ctx: InterpreterContext, name: string): void;
/**
 * Check if a name refers to a valid, existing variable or array element.
 * Used to determine if a nameref target is "real" or just a stored value.
 */
export declare function targetExists(ctx: InterpreterContext, target: string): boolean;
/**
 * Resolve a nameref chain to the final variable name.
 * Returns the original name if it's not a nameref.
 * Detects circular references and returns undefined.
 *
 * @param ctx - The interpreter context
 * @param name - The variable name to resolve
 * @param maxDepth - Maximum chain depth to prevent infinite loops (default 100)
 * @returns The resolved variable name, or undefined if circular reference detected
 */
export declare function resolveNameref(ctx: InterpreterContext, name: string, maxDepth?: number): string | undefined;
/**
 * Get the target name of a nameref (what it points to).
 * Returns the variable's value if it's a nameref, undefined otherwise.
 */
export declare function getNamerefTarget(ctx: InterpreterContext, name: string): string | undefined;
/**
 * Resolve a nameref for assignment purposes.
 * Unlike resolveNameref, this will resolve to the target variable name
 * even if the target doesn't exist yet (allowing creation).
 *
 * @param ctx - The interpreter context
 * @param name - The variable name to resolve
 * @param valueBeingAssigned - The value being assigned (needed for empty nameref handling)
 * @param maxDepth - Maximum chain depth to prevent infinite loops
 * @returns
 * - undefined if circular reference detected
 * - null if the nameref is empty and value is not an existing variable (skip assignment)
 * - The resolved target name otherwise (may be the nameref itself if target is invalid)
 */
export declare function resolveNamerefForAssignment(ctx: InterpreterContext, name: string, valueBeingAssigned?: string, maxDepth?: number): string | null | undefined;
