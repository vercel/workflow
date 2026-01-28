/**
 * local - Declare local variables in functions builtin
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleLocal(ctx: InterpreterContext, args: string[]): Promise<ExecResult>;
