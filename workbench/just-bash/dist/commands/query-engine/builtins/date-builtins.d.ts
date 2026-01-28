/**
 * Date/time-related jq builtins
 *
 * Handles date and time functions like now, gmtime, mktime, strftime, strptime, etc.
 */
import type { EvalContext } from "../evaluator.js";
import type { AstNode } from "../parser.js";
import type { QueryValue } from "../value-operations.js";
type EvalFn = (value: QueryValue, ast: AstNode, ctx: EvalContext) => QueryValue[];
/**
 * Handle date builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not a date builtin handled here.
 */
export declare function evalDateBuiltin(value: QueryValue, name: string, args: AstNode[], ctx: EvalContext, evaluate: EvalFn): QueryValue[] | null;
export {};
