/**
 * AWK Built-in Functions
 *
 * Implementation of AWK built-in functions for the AST-based interpreter.
 */
import type { AwkExpr } from "./ast.js";
import type { AwkRuntimeContext } from "./interpreter/context.js";
import type { AwkValue } from "./interpreter/types.js";
/**
 * Interface for evaluating expressions (passed from interpreter)
 */
export interface AwkEvaluator {
    evalExpr: (expr: AwkExpr) => Promise<AwkValue>;
}
export type AwkBuiltinFn = (args: AwkExpr[], ctx: AwkRuntimeContext, evaluator: AwkEvaluator) => AwkValue | Promise<AwkValue>;
export declare function formatPrintf(format: string, values: AwkValue[]): string;
export declare const awkBuiltins: Record<string, AwkBuiltinFn>;
