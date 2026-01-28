/**
 * File reading utilities for command implementations.
 *
 * Provides common patterns for reading from files or stdin,
 * including parallel batch reading for performance.
 */
import type { CommandContext, ExecResult } from "../types.js";
export interface ReadFilesOptions {
    /** Command name for error messages */
    cmdName: string;
    /** If true, "-" in file list means stdin */
    allowStdinMarker?: boolean;
    /** If true, stop on first error. If false, collect errors and continue */
    stopOnError?: boolean;
    /** Number of files to read in parallel (default: 100). Set to 1 for sequential. */
    batchSize?: number;
}
export interface FileContent {
    /** File name (or "-" for stdin, or "" if stdin with no files) */
    filename: string;
    /** File content */
    content: string;
}
export interface ReadFilesResult {
    /** Successfully read files */
    files: FileContent[];
    /** Error messages (e.g., "cmd: file: No such file or directory\n") */
    stderr: string;
    /** 0 if all files read successfully, 1 if any errors */
    exitCode: number;
}
/**
 * Read content from files or stdin.
 *
 * If files array is empty, reads from stdin.
 * If files contains "-", reads stdin at that position.
 *
 * @example
 * const result = await readFiles(ctx, files, { cmdName: "cat" });
 * if (result.exitCode !== 0 && options.stopOnError) {
 *   return { stdout: "", stderr: result.stderr, exitCode: result.exitCode };
 * }
 * for (const { filename, content } of result.files) {
 *   // process content
 * }
 */
export declare function readFiles(ctx: CommandContext, files: string[], options: ReadFilesOptions): Promise<ReadFilesResult>;
/**
 * Read and concatenate all files into a single string.
 *
 * Useful for commands like sort and uniq that process all input together.
 *
 * @example
 * const result = await readAndConcat(ctx, files, { cmdName: "sort" });
 * if (!result.ok) return result.error;
 * const lines = result.content.split("\n");
 */
export declare function readAndConcat(ctx: CommandContext, files: string[], options: {
    cmdName: string;
    allowStdinMarker?: boolean;
}): Promise<{
    ok: true;
    content: string;
} | {
    ok: false;
    error: ExecResult;
}>;
