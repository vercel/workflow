/**
 * read - Read a line of input builtin
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleRead(ctx: InterpreterContext, args: string[], stdin: string, stdinSourceFd?: number): ExecResult;
