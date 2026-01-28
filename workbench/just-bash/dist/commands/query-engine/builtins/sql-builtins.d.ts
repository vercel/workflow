/**
 * SQL-like jq builtins
 *
 * Handles IN, INDEX, and JOIN functions.
 */
import type { EvalContext } from "../evaluator.js";
import type { AstNode } from "../parser.js";
import type { QueryValue } from "../value-operations.js";
type EvalFn = (value: QueryValue, ast: AstNode, ctx: EvalContext) => QueryValue[];
type DeepEqualFn = (a: QueryValue, b: QueryValue) => boolean;
/**
 * Handle SQL-like builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not a SQL builtin handled here.
 */
export declare function evalSqlBuiltin(value: QueryValue, name: string, args: AstNode[], ctx: EvalContext, evaluate: EvalFn, deepEqual: DeepEqualFn): QueryValue[] | null;
export {};
