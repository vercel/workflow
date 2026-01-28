/**
 * Navigation and traversal jq builtins
 *
 * Handles recurse, recurse_down, walk, transpose, combinations, parent, parents, root.
 */
import type { EvalContext } from "../evaluator.js";
import type { AstNode } from "../parser.js";
import type { QueryValue } from "../value-operations.js";
type EvalFn = (value: QueryValue, ast: AstNode, ctx: EvalContext) => QueryValue[];
type IsTruthyFn = (v: QueryValue) => boolean;
type GetValueAtPathFn = (obj: QueryValue, path: (string | number)[]) => QueryValue;
type EvalBuiltinFn = (value: QueryValue, name: string, args: AstNode[], ctx: EvalContext) => QueryValue[];
/**
 * Handle navigation builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not a navigation builtin handled here.
 */
export declare function evalNavigationBuiltin(value: QueryValue, name: string, args: AstNode[], ctx: EvalContext, evaluate: EvalFn, isTruthy: IsTruthyFn, getValueAtPath: GetValueAtPathFn, evalBuiltin: EvalBuiltinFn): QueryValue[] | null;
export {};
