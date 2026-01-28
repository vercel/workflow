/**
 * Indirect Array Expansion Handlers
 *
 * Handles "${!ref}" style indirect expansions where ref points to an array:
 * - "${!ref}" where ref='arr[@]' or ref='arr[*]'
 * - "${!ref:offset}" and "${!ref:offset:length}" - array slicing via indirection
 * - "${!ref:-default}" and "${!ref:+alternative}" - default/alternative via indirection
 * - "${ref+${!ref}}" - indirect in alternative value
 */
import type { ParameterExpansionPart, WordPart } from "../../ast/types.js";
import type { InterpreterContext } from "../types.js";
/**
 * Result type for indirect expansion handlers.
 * `null` means the handler doesn't apply to this case.
 */
export type IndirectExpansionResult = {
    values: string[];
    quoted: boolean;
} | null;
/**
 * Type for expandParameterAsync function reference
 */
export type ExpandParameterAsyncFn = (ctx: InterpreterContext, part: ParameterExpansionPart, inDoubleQuotes?: boolean) => Promise<string>;
/**
 * Type for expandWordPartsAsync function reference
 */
export type ExpandWordPartsAsyncFn = (ctx: InterpreterContext, parts: WordPart[], inDoubleQuotes?: boolean) => Promise<string>;
/**
 * Handle "${!ref}" where ref='arr[@]' or ref='arr[*]' - indirect array expansion.
 * This handles all the inner operation cases as well.
 */
export declare function handleIndirectArrayExpansion(ctx: InterpreterContext, wordParts: WordPart[], hasIndirection: boolean, expandParameterAsync: ExpandParameterAsyncFn, expandWordPartsAsync: ExpandWordPartsAsyncFn): Promise<IndirectExpansionResult>;
/**
 * Handle ${ref+${!ref}} or ${ref-${!ref}} - indirect in alternative/default value.
 * This handles patterns like: ${hooksSlice+"${!hooksSlice}"} which should preserve element boundaries
 */
export declare function handleIndirectInAlternative(ctx: InterpreterContext, wordParts: WordPart[]): Promise<IndirectExpansionResult>;
/**
 * Handle ${!ref+${!ref}} or ${!ref-${!ref}} - indirect with innerOp in alternative/default value.
 * This handles patterns like: ${!hooksSlice+"${!hooksSlice}"} which should preserve element boundaries
 */
export declare function handleIndirectionWithInnerAlternative(ctx: InterpreterContext, wordParts: WordPart[]): Promise<IndirectExpansionResult>;
