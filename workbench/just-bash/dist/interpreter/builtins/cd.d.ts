/**
 * cd - Change directory builtin
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleCd(ctx: InterpreterContext, args: string[]): Promise<ExecResult>;
