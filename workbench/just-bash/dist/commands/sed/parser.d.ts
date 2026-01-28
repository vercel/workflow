import type { SedCommand } from "./types.js";
/**
 * Parse multiple sed scripts into a list of commands.
 * This is the main entry point for parsing sed scripts.
 *
 * Also detects #n or #r special comments at the start of the first script:
 * - #n enables silent mode (equivalent to -n flag)
 * - #r enables extended regex mode (equivalent to -r/-E flag)
 *
 * Handles backslash continuation across -e arguments:
 * - If a script ends with \, the next script is treated as continuation
 */
export declare function parseMultipleScripts(scripts: string[], extendedRegex?: boolean): {
    commands: SedCommand[];
    error?: string;
    silentMode?: boolean;
    extendedRegexMode?: boolean;
};
