/**
 * Argument parsing for rg command - Declarative approach
 */
import type { ExecResult } from "../../types.js";
import { type RgOptions } from "./rg-options.js";
export interface ParseResult {
    success: true;
    options: RgOptions;
    paths: string[];
    explicitLineNumbers: boolean;
}
export interface ParseError {
    success: false;
    error: ExecResult;
}
export type ParseArgsResult = ParseResult | ParseError;
/**
 * Parse rg command arguments
 */
export declare function parseArgs(args: string[]): ParseArgsResult;
