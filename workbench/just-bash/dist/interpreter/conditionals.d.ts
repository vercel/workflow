/**
 * Conditional Expression Evaluation
 *
 * Handles:
 * - [[ ... ]] conditional commands
 * - [ ... ] and test commands
 * - File tests (-f, -d, -e, etc.)
 * - String tests (-z, -n, =, !=)
 * - Numeric comparisons (-eq, -ne, -lt, etc.)
 * - Pattern matching (==, =~)
 */
import type { ConditionalExpressionNode } from "../ast/types.js";
import type { ExecResult } from "../types.js";
import type { InterpreterContext } from "./types.js";
export declare function evaluateConditional(ctx: InterpreterContext, expr: ConditionalExpressionNode): Promise<boolean>;
export declare function evaluateTestArgs(ctx: InterpreterContext, args: string[]): Promise<ExecResult>;
export declare function matchPattern(value: string, pattern: string, nocasematch?: boolean, extglob?: boolean): boolean;
