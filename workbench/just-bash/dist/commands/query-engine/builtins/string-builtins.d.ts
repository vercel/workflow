/**
 * String-related jq builtins
 *
 * Handles string manipulation functions like join, split, test, match, gsub, etc.
 */
import type { EvalContext } from "../evaluator.js";
import type { AstNode } from "../parser.js";
import type { QueryValue } from "../value-operations.js";
type EvalFn = (value: QueryValue, ast: AstNode, ctx: EvalContext) => QueryValue[];
/**
 * Handle string builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not a string builtin handled here.
 */
export declare function evalStringBuiltin(value: QueryValue, name: string, args: AstNode[], ctx: EvalContext, evaluate: EvalFn): QueryValue[] | null;
export {};
