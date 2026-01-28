/**
 * Command Resolution
 *
 * Handles PATH-based command resolution and lookup for external commands.
 */
import type { IFileSystem } from "../fs/interface.js";
import type { Command, CommandRegistry } from "../types.js";
import type { InterpreterState } from "./types.js";
/**
 * Context needed for command resolution
 */
export interface CommandResolutionContext {
    fs: IFileSystem;
    state: InterpreterState;
    commands: CommandRegistry;
}
/**
 * Result type for command resolution
 */
export type ResolveCommandResult = {
    cmd: Command;
    path: string;
} | {
    script: true;
    path: string;
} | {
    error: "not_found" | "permission_denied";
    path?: string;
} | null;
/**
 * Resolve a command name to its implementation via PATH lookup.
 * Returns the command and its resolved path, or null if not found.
 *
 * Resolution order:
 * 1. If command contains "/", resolve as a path
 * 2. Search PATH directories for the command file
 * 3. Fall back to registry lookup (for non-InMemoryFs filesystems like OverlayFs)
 */
export declare function resolveCommand(ctx: CommandResolutionContext, commandName: string, pathOverride?: string): Promise<ResolveCommandResult>;
/**
 * Find all paths for a command in PATH (for `which -a`).
 */
export declare function findCommandInPath(ctx: CommandResolutionContext, commandName: string): Promise<string[]>;
