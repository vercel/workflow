/**
 * Object-related jq builtins
 *
 * Handles object manipulation functions like keys, to_entries, from_entries, etc.
 */
import type { EvalContext } from "../evaluator.js";
import type { AstNode } from "../parser.js";
import { type QueryValue } from "../value-operations.js";
type EvalFn = (value: QueryValue, ast: AstNode, ctx: EvalContext) => QueryValue[];
/**
 * Handle object builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not an object builtin handled here.
 */
export declare function evalObjectBuiltin(value: QueryValue, name: string, args: AstNode[], ctx: EvalContext, evaluate: EvalFn): QueryValue[] | null;
export {};
