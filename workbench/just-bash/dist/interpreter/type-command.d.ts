/**
 * Type Command Implementation
 *
 * Implements the `type` builtin command and related functionality:
 * - type [-afptP] name...
 * - command -v/-V name...
 *
 * Also includes helpers for function source serialization.
 */
import type { IFileSystem } from "../fs/interface.js";
import type { CommandRegistry, ExecResult } from "../types.js";
import type { InterpreterState } from "./types.js";
/**
 * Context needed for type command operations
 */
export interface TypeCommandContext {
    state: InterpreterState;
    fs: IFileSystem;
    commands: CommandRegistry;
}
/**
 * Handle the `type` builtin command.
 * type [-afptP] name...
 */
export declare function handleType(ctx: TypeCommandContext, args: string[], findFirstInPath: (name: string) => Promise<string | null>, findCommandInPath: (name: string) => Promise<string[]>): Promise<ExecResult>;
/**
 * Handle `command -v` and `command -V` flags
 * -v: print the name or path of the command (simple output)
 * -V: print a description like `type` does (verbose output)
 */
export declare function handleCommandV(ctx: TypeCommandContext, names: string[], _showPath: boolean, verboseDescribe: boolean): Promise<ExecResult>;
/**
 * Find the first occurrence of a command in PATH.
 * Returns the full path if found, null otherwise.
 * Only returns executable files, not directories.
 */
export declare function findFirstInPath(ctx: TypeCommandContext, name: string): Promise<string | null>;
