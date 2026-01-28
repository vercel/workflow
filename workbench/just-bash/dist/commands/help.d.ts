import type { ExecResult } from "../types.js";
export interface HelpInfo {
    name: string;
    summary: string;
    usage: string;
    description?: string | string[];
    options?: string[];
    examples?: string[];
    notes?: string[];
}
export declare function showHelp(info: HelpInfo): ExecResult;
export declare function hasHelpFlag(args: string[]): boolean;
/**
 * Returns an error result for an unknown option
 */
export declare function unknownOption(cmdName: string, option: string): ExecResult;
