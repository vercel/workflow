/**
 * Word Expansion
 *
 * Handles shell word expansion including:
 * - Variable expansion ($VAR, ${VAR})
 * - Command substitution $(...)
 * - Arithmetic expansion $((...))
 * - Tilde expansion (~)
 * - Brace expansion {a,b,c}
 * - Glob expansion (*, ?, [...])
 */
import type { WordNode } from "../ast/types.js";
import type { InterpreterContext } from "./types.js";
export { escapeGlobChars, escapeRegexChars } from "./expansion/glob-escape.js";
export { getArrayElements, getVariable, isArray, } from "./expansion/variable.js";
/**
 * Check if an entire word is fully quoted
 */
export declare function isWordFullyQuoted(word: WordNode): boolean;
export declare function expandWord(ctx: InterpreterContext, word: WordNode): Promise<string>;
/**
 * Expand a word for use as a regex pattern (in [[ =~ ]]).
 * Preserves backslash escapes so they're passed to the regex engine.
 * For example, \[\] becomes \[\] in the regex (matching literal [ and ]).
 */
export declare function expandWordForRegex(ctx: InterpreterContext, word: WordNode): Promise<string>;
/**
 * Expand a word for use as a pattern (e.g., in [[ == ]] or case).
 * Preserves backslash escapes for pattern metacharacters so they're treated literally.
 * This prevents `*\(\)` from being interpreted as an extglob pattern.
 */
export declare function expandWordForPattern(ctx: InterpreterContext, word: WordNode): Promise<string>;
export declare function expandWordWithGlob(ctx: InterpreterContext, word: WordNode): Promise<{
    values: string[];
    quoted: boolean;
}>;
export declare function hasQuotedMultiValueAt(ctx: InterpreterContext, word: WordNode): boolean;
/**
 * Expand a redirect target with glob handling.
 *
 * For redirects:
 * - If glob matches 0 files with failglob → error (returns { error: ... })
 * - If glob matches 0 files without failglob → use literal pattern
 * - If glob matches 1 file → use that file
 * - If glob matches 2+ files → "ambiguous redirect" error
 *
 * Returns { target: string } on success or { error: string } on failure.
 */
export declare function expandRedirectTarget(ctx: InterpreterContext, word: WordNode): Promise<{
    target: string;
} | {
    error: string;
}>;
