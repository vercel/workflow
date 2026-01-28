/**
 * Shared utilities for head and tail commands.
 */
import type { CommandContext, ExecResult } from "../../types.js";
export interface HeadTailOptions {
    lines: number;
    bytes: number | null;
    quiet: boolean;
    verbose: boolean;
    files: string[];
    /** tail-specific: start from line N instead of last N lines */
    fromLine?: boolean;
}
export type HeadTailParseResult = {
    ok: true;
    options: HeadTailOptions;
} | {
    ok: false;
    error: ExecResult;
};
/**
 * Parse head/tail command arguments.
 * Both commands share most options, with tail having additional +N syntax.
 */
export declare function parseHeadTailArgs(args: string[], cmdName: "head" | "tail"): HeadTailParseResult;
/**
 * Process files for head/tail commands.
 * Handles stdin, multiple files, headers, and error handling.
 */
export declare function processHeadTailFiles(ctx: CommandContext, options: HeadTailOptions, cmdName: "head" | "tail", contentProcessor: (content: string) => string): Promise<ExecResult>;
/**
 * Get the first N lines or bytes from content.
 */
export declare function getHead(content: string, lines: number, bytes: number | null): string;
/**
 * Get the last N lines or bytes from content.
 */
export declare function getTail(content: string, lines: number, bytes: number | null, fromLine: boolean): string;
