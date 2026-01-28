/**
 * Function Handling
 *
 * Handles shell function definition and invocation:
 * - Function definition (adding to function table)
 * - Function calls (with positional parameters and local scopes)
 */
import type { FunctionDefNode } from "../ast/types.js";
import type { ExecResult } from "../types.js";
import type { InterpreterContext } from "./types.js";
export declare function executeFunctionDef(ctx: InterpreterContext, node: FunctionDefNode): ExecResult;
export declare function callFunction(ctx: InterpreterContext, func: FunctionDefNode, args: string[], stdin?: string, callLine?: number): Promise<ExecResult>;
