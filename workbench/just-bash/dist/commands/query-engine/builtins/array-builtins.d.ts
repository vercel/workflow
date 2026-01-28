/**
 * Array-related jq builtins
 *
 * Handles array manipulation functions like sort, sort_by, group_by, max, min, add, etc.
 */
import type { EvalContext } from "../evaluator.js";
import type { AstNode } from "../parser.js";
import type { QueryValue } from "../value-operations.js";
type EvalFn = (value: QueryValue, ast: AstNode, ctx: EvalContext) => QueryValue[];
type EvalWithPartialFn = (value: QueryValue, ast: AstNode, ctx: EvalContext) => QueryValue[];
type CompareFn = (a: QueryValue, b: QueryValue) => number;
type IsTruthyFn = (v: QueryValue) => boolean;
type ContainsDeepFn = (a: QueryValue, b: QueryValue) => boolean;
type ExecutionLimitErrorClass = new (message: string, kind: "recursion" | "commands" | "iterations") => Error;
/**
 * Handle array builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not an array builtin handled here.
 */
export declare function evalArrayBuiltin(value: QueryValue, name: string, args: AstNode[], ctx: EvalContext, evaluate: EvalFn, evaluateWithPartialResults: EvalWithPartialFn, compareJq: CompareFn, isTruthy: IsTruthyFn, containsDeep: ContainsDeepFn, ExecutionLimitError: ExecutionLimitErrorClass): QueryValue[] | null;
export {};
