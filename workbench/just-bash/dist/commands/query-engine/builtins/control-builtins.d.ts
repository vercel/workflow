/**
 * Control flow jq builtins
 *
 * Handles first, last, nth, range, limit, isempty, isvalid, skip, until, while, repeat.
 */
import type { EvalContext } from "../evaluator.js";
import type { AstNode } from "../parser.js";
import type { QueryValue } from "../value-operations.js";
type EvalFn = (value: QueryValue, ast: AstNode, ctx: EvalContext) => QueryValue[];
type EvalWithPartialFn = (value: QueryValue, ast: AstNode, ctx: EvalContext) => QueryValue[];
type IsTruthyFn = (v: QueryValue) => boolean;
type ExecutionLimitErrorClass = new (message: string, kind: "recursion" | "commands" | "iterations") => Error;
/**
 * Handle control flow builtins.
 * Returns null if the builtin name is not a control builtin handled here.
 */
export declare function evalControlBuiltin(value: QueryValue, name: string, args: AstNode[], ctx: EvalContext, evaluate: EvalFn, evaluateWithPartialResults: EvalWithPartialFn, isTruthy: IsTruthyFn, ExecutionLimitError: ExecutionLimitErrorClass): QueryValue[] | null;
export {};
