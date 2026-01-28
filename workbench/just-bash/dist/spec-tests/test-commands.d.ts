/**
 * Test helper commands for spec tests
 * These replace the Python scripts used in the original Oil shell tests
 *
 * NOTE: Standard Unix commands (tac, od, hostname) are now in src/commands/
 */
import type { Command } from "../types.js";
export declare const argvCommand: Command;
export declare const printenvCommand: Command;
export declare const stdoutStderrCommand: Command;
export declare const readFromFdCommand: Command;
/** All test helper commands (Python script replacements) */
export declare const testHelperCommands: Command[];
