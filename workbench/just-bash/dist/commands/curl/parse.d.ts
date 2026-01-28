/**
 * Option parsing for curl command
 */
import type { ExecResult } from "../../types.js";
import type { CurlOptions } from "./types.js";
/**
 * Parse curl command line arguments
 */
export declare function parseOptions(args: string[]): CurlOptions | ExecResult;
