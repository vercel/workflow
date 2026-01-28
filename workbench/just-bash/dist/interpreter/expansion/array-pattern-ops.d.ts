/**
 * Array Pattern Operations
 *
 * Handles pattern replacement and pattern removal for array expansions:
 * - "${arr[@]/pattern/replacement}" - pattern replacement
 * - "${arr[@]#pattern}" - prefix removal
 * - "${arr[@]%pattern}" - suffix removal
 */
import type { WordPart } from "../../ast/types.js";
import type { InterpreterContext } from "../types.js";
import type { ArrayExpansionResult, ExpandPartFn, ExpandWordPartsAsyncFn } from "./array-word-expansion.js";
/**
 * Handle "${arr[@]/pattern/replacement}" and "${arr[*]/pattern/replacement}"
 * Returns null if this handler doesn't apply.
 */
export declare function handleArrayPatternReplacement(ctx: InterpreterContext, wordParts: WordPart[], expandWordPartsAsync: ExpandWordPartsAsyncFn, expandPart: ExpandPartFn): Promise<ArrayExpansionResult>;
/**
 * Handle "${arr[@]#pattern}" and "${arr[*]#pattern}" - array pattern removal
 * Returns null if this handler doesn't apply.
 */
export declare function handleArrayPatternRemoval(ctx: InterpreterContext, wordParts: WordPart[], expandWordPartsAsync: ExpandWordPartsAsyncFn, expandPart: ExpandPartFn): Promise<ArrayExpansionResult>;
