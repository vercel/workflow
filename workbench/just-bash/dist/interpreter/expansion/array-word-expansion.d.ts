/**
 * Array Word Expansion Handlers
 *
 * Handles complex array expansion cases in word expansion:
 * - "${arr[@]}" and "${arr[*]}" - array element expansion
 * - "${arr[@]:-default}" - array with defaults
 * - "${arr[@]:offset:length}" - array slicing
 * - "${arr[@]/pattern/replacement}" - pattern replacement
 * - "${arr[@]#pattern}" - pattern removal
 * - "${arr[@]@op}" - transform operations
 */
import type { WordPart } from "../../ast/types.js";
import type { InterpreterContext } from "../types.js";
/**
 * Result type for array expansion handlers.
 * `null` means the handler doesn't apply to this case.
 */
export type ArrayExpansionResult = {
    values: string[];
    quoted: boolean;
} | null;
/**
 * Helper type for expandWordPartsAsync function reference
 */
export type ExpandWordPartsAsyncFn = (ctx: InterpreterContext, parts: WordPart[]) => Promise<string>;
/**
 * Helper type for expandPart function reference
 */
export type ExpandPartFn = (ctx: InterpreterContext, part: WordPart) => Promise<string>;
/**
 * Handle simple "${arr[@]}" expansion without operations.
 * Returns each array element as a separate word.
 */
export declare function handleSimpleArrayExpansion(ctx: InterpreterContext, wordParts: WordPart[]): ArrayExpansionResult;
/**
 * Handle namerefs pointing to array[@] - "${ref}" where ref='arr[@]'
 * When a nameref points to array[@], expanding "$ref" should produce multiple words
 */
export declare function handleNamerefArrayExpansion(ctx: InterpreterContext, wordParts: WordPart[]): ArrayExpansionResult;
