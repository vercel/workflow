/**
 * Math-related jq builtins
 *
 * Handles mathematical functions like abs, pow, exp, trig functions, etc.
 */
import type { EvalContext } from "../evaluator.js";
import type { AstNode } from "../parser.js";
import type { QueryValue } from "../value-operations.js";
type EvalFn = (value: QueryValue, ast: AstNode, ctx: EvalContext) => QueryValue[];
/**
 * Handle math builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not a math builtin handled here.
 */
export declare function evalMathBuiltin(value: QueryValue, name: string, args: AstNode[], ctx: EvalContext, evaluate: EvalFn): QueryValue[] | null;
export {};
