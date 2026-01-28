/**
 * Builtin Command Dispatch
 *
 * Handles dispatch of built-in shell commands like export, unset, cd, etc.
 * Separated from interpreter.ts for modularity.
 */
import type { ExecResult } from "../types.js";
import type { InterpreterContext } from "./types.js";
/**
 * Type for the function that runs a command recursively
 */
export type RunCommandFn = (commandName: string, args: string[], quotedArgs: boolean[], stdin: string, skipFunctions?: boolean, useDefaultPath?: boolean, stdinSourceFd?: number) => Promise<ExecResult>;
/**
 * Type for the function that builds exported environment
 */
export type BuildExportedEnvFn = () => Record<string, string>;
/**
 * Type for the function that executes user scripts
 */
export type ExecuteUserScriptFn = (scriptPath: string, args: string[], stdin?: string) => Promise<ExecResult>;
/**
 * Dispatch context containing dependencies needed for builtin dispatch
 */
export interface BuiltinDispatchContext {
    ctx: InterpreterContext;
    runCommand: RunCommandFn;
    buildExportedEnv: BuildExportedEnvFn;
    executeUserScript: ExecuteUserScriptFn;
}
/**
 * Dispatch a command to the appropriate builtin handler or external command.
 * Returns null if the command should be handled by external command resolution.
 */
export declare function dispatchBuiltin(dispatchCtx: BuiltinDispatchContext, commandName: string, args: string[], _quotedArgs: boolean[], stdin: string, skipFunctions: boolean, _useDefaultPath: boolean, stdinSourceFd: number): Promise<ExecResult | null>;
/**
 * Handle external command resolution and execution.
 * Called when dispatchBuiltin returns null.
 */
export declare function executeExternalCommand(dispatchCtx: BuiltinDispatchContext, commandName: string, args: string[], stdin: string, useDefaultPath: boolean): Promise<ExecResult>;
