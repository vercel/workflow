/**
 * source/. - Execute commands from a file in current environment builtin
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleSource(ctx: InterpreterContext, args: string[]): Promise<ExecResult>;
