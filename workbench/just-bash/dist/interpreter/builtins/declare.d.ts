/**
 * declare/typeset - Declare variables and give them attributes
 *
 * Usage:
 *   declare              - List all variables
 *   declare -p           - List all variables (same as no args)
 *   declare NAME=value   - Declare variable with value
 *   declare -a NAME      - Declare indexed array
 *   declare -A NAME      - Declare associative array
 *   declare -r NAME      - Declare readonly variable
 *   declare -x NAME      - Export variable
 *   declare -g NAME      - Declare global variable (inside functions)
 *
 * Also aliased as 'typeset'
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
/**
 * Check if a variable has the integer attribute.
 */
export declare function isInteger(ctx: InterpreterContext, name: string): boolean;
/**
 * Apply case transformation based on variable attributes.
 * Returns the transformed value.
 */
export declare function applyCaseTransform(ctx: InterpreterContext, name: string, value: string): string;
export declare function handleDeclare(ctx: InterpreterContext, args: string[]): Promise<ExecResult>;
/**
 * readonly - Declare readonly variables
 *
 * Usage:
 *   readonly NAME=value   - Declare readonly variable
 *   readonly NAME         - Mark existing variable as readonly
 */
export declare function handleReadonly(ctx: InterpreterContext, args: string[]): Promise<ExecResult>;
