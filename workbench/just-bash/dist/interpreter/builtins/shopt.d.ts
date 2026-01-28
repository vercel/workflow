/**
 * shopt builtin - Shell options
 * Implements bash's shopt builtin for managing shell-specific options
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleShopt(ctx: InterpreterContext, args: string[]): ExecResult;
