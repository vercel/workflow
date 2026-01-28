/**
 * eval - Execute arguments as a shell command
 *
 * Concatenates all arguments and executes them as a shell command
 * in the current environment (variables persist after eval).
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleEval(ctx: InterpreterContext, args: string[], stdin?: string): Promise<ExecResult>;
