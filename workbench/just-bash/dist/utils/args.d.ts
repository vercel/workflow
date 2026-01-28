/**
 * Lightweight argument parser for command implementations.
 *
 * Handles common patterns:
 * - Boolean flags: -n, --number
 * - Combined short flags: -rn (same as -r -n)
 * - Value options: -k VALUE, -kVALUE, --key=VALUE, --key VALUE
 * - Positional arguments
 * - Unknown option detection
 */
import type { ExecResult } from "../types.js";
export type ArgType = "boolean" | "string" | "number";
export interface ArgDef {
    /** Short form without dash, e.g., "n" for -n */
    short?: string;
    /** Long form without dashes, e.g., "number" for --number */
    long?: string;
    /** Type of the argument */
    type: ArgType;
    /** Default value */
    default?: boolean | string | number;
}
export interface ParsedArgs<T extends Record<string, ArgDef>> {
    /** Parsed flag/option values */
    flags: {
        [K in keyof T]: T[K]["type"] extends "boolean" ? boolean : T[K]["default"] extends number | string ? T[K]["type"] extends "number" ? number : string : T[K]["type"] extends "number" ? number | undefined : string | undefined;
    };
    /** Positional arguments (non-flag arguments) */
    positional: string[];
}
export type ParseResult<T extends Record<string, ArgDef>> = {
    ok: true;
    result: ParsedArgs<T>;
} | {
    ok: false;
    error: ExecResult;
};
/**
 * Parse command arguments according to the provided definitions.
 *
 * @param cmdName - Command name for error messages
 * @param args - Arguments to parse
 * @param defs - Argument definitions
 * @returns Parsed arguments or error result
 *
 * @example
 * const defs = {
 *   reverse: { short: "r", long: "reverse", type: "boolean" as const },
 *   count: { short: "n", long: "lines", type: "number" as const, default: 10 },
 * };
 * const result = parseArgs("head", args, defs);
 * if (!result.ok) return result.error;
 * const { flags, positional } = result.result;
 */
export declare function parseArgs<T extends Record<string, ArgDef>>(cmdName: string, args: string[], defs: T): ParseResult<T>;
