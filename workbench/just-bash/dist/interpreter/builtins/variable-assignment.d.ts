/**
 * Variable assignment helpers for declare, readonly, local, export builtins.
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
/**
 * Result of parsing an assignment argument.
 */
export interface ParsedAssignment {
    name: string;
    isArray: boolean;
    arrayElements?: string[];
    value?: string;
    /** For array index assignment: a[index]=value */
    arrayIndex?: string;
}
/**
 * Parse an assignment argument like "name=value", "name=(a b c)", or "name[index]=value".
 */
export declare function parseAssignment(arg: string): ParsedAssignment;
/**
 * Options for setting a variable.
 */
export interface SetVariableOptions {
    makeReadonly?: boolean;
    checkReadonly?: boolean;
}
/**
 * Set a variable from a parsed assignment.
 * Returns an error result if the variable is readonly, otherwise null.
 */
export declare function setVariable(ctx: InterpreterContext, assignment: ParsedAssignment, options?: SetVariableOptions): Promise<ExecResult | null>;
/**
 * Mark a variable as being declared at the current call depth.
 * Used for bash-specific unset scoping behavior.
 */
export declare function markLocalVarDepth(ctx: InterpreterContext, name: string): void;
/**
 * Get the call depth at which a local variable was declared.
 * Returns undefined if the variable is not a local variable.
 */
export declare function getLocalVarDepth(ctx: InterpreterContext, name: string): number | undefined;
/**
 * Clear the local variable depth tracking for a variable.
 * Called when a local variable is cell-unset (dynamic-unset).
 */
export declare function clearLocalVarDepth(ctx: InterpreterContext, name: string): void;
/**
 * Push the current value of a variable onto the local var stack.
 * Used for bash's localvar-nest behavior where nested local declarations
 * each create a new cell that can be unset independently.
 */
export declare function pushLocalVarStack(ctx: InterpreterContext, name: string, currentValue: string | undefined): void;
/**
 * Pop the top entry from the local var stack for a variable.
 * Returns the saved value and scope index if there was an entry, or undefined if the stack was empty.
 */
export declare function popLocalVarStack(ctx: InterpreterContext, name: string): {
    value: string | undefined;
    scopeIndex: number;
} | undefined;
/**
 * Clear all local var stack entries for a specific scope index.
 * Called when a function returns and its local scope is popped.
 */
export declare function clearLocalVarStackForScope(ctx: InterpreterContext, scopeIndex: number): void;
