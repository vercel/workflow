/**
 * Index-related jq builtins
 *
 * Handles index, rindex, and indices functions for finding positions in arrays/strings.
 */
import type { EvalContext } from "../evaluator.js";
import type { AstNode } from "../parser.js";
import type { QueryValue } from "../value-operations.js";
type EvalFn = (value: QueryValue, ast: AstNode, ctx: EvalContext) => QueryValue[];
type DeepEqualFn = (a: QueryValue, b: QueryValue) => boolean;
/**
 * Handle index builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not an index builtin handled here.
 */
export declare function evalIndexBuiltin(value: QueryValue, name: string, args: AstNode[], ctx: EvalContext, evaluate: EvalFn, deepEqual: DeepEqualFn): QueryValue[] | null;
export {};
