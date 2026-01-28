/**
 * let - Evaluate arithmetic expressions
 *
 * Usage:
 *   let expr [expr ...]
 *   let "x=1" "y=x+2"
 *
 * Each argument is evaluated as an arithmetic expression.
 * Returns 0 if the last expression evaluates to non-zero,
 * returns 1 if it evaluates to zero.
 *
 * Note: In bash, `let x=( 1 )` passes separate args ["x=(", "1", ")"]
 * when not quoted. The let builtin needs to handle this by joining
 * arguments that are part of the same expression.
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleLet(ctx: InterpreterContext, args: string[]): Promise<ExecResult>;
