/**
 * Interpreter Utility Functions
 *
 * Standalone helper functions used by the interpreter.
 */
import type { WordNode } from "../../ast/types.js";
/**
 * Check if a WordNode is a literal match for any of the given strings.
 * Returns true only if the word is a single literal (no expansions, no quoting)
 * that matches one of the target strings.
 *
 * This is used to detect assignment builtins at "parse time" - bash determines
 * whether a command is export/declare/etc based on the literal token, not the
 * runtime value after expansion.
 */
export declare function isWordLiteralMatch(word: WordNode, targets: string[]): boolean;
/**
 * Parse the content of a read-write file descriptor.
 * Format: __rw__:pathLength:path:position:content
 * @returns The parsed components, or null if format is invalid
 */
export declare function parseRwFdContent(fdContent: string): {
    path: string;
    position: number;
    content: string;
} | null;
