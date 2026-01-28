/**
 * return - Return from a function with an exit code
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleReturn(ctx: InterpreterContext, args: string[]): ExecResult;
