/**
 * break - Exit from loops builtin
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleBreak(ctx: InterpreterContext, args: string[]): ExecResult;
