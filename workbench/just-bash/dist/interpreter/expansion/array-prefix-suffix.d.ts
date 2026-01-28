/**
 * Array Expansion with Prefix/Suffix Handlers
 *
 * Handles array expansions that have adjacent text in double quotes:
 * - "${prefix}${arr[@]#pattern}${suffix}" - pattern removal with prefix/suffix
 * - "${prefix}${arr[@]/pattern/replacement}${suffix}" - pattern replacement with prefix/suffix
 * - "${prefix}${arr[@]}${suffix}" - simple array expansion with prefix/suffix
 * - "${arr[@]:-${default[@]}}" - array default/alternative values
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
 * Type for expandPart function reference
 */
export type ExpandPartFn = (ctx: InterpreterContext, part: WordPart) => Promise<string>;
/**
 * Type for expandWordPartsAsync function reference
 */
export type ExpandWordPartsAsyncFn = (ctx: InterpreterContext, parts: WordPart[]) => Promise<string>;
/**
 * Handle "${arr[@]:-${default[@]}}", "${arr[@]:+${alt[@]}}", and "${arr[@]:=default}"
 * Also handles "${var:-${default[@]}}" where var is a scalar variable.
 * When the default value contains an array expansion, each element should become a separate word.
 */
export declare function handleArrayDefaultValue(ctx: InterpreterContext, wordParts: WordPart[]): Promise<ArrayExpansionResult>;
/**
 * Handle "${prefix}${arr[@]#pattern}${suffix}" and "${prefix}${arr[@]/pat/rep}${suffix}"
 * Array pattern operations with adjacent text in double quotes.
 * Each array element has the pattern applied, then becomes a separate word
 * with prefix joined to first and suffix joined to last.
 */
export declare function handleArrayPatternWithPrefixSuffix(ctx: InterpreterContext, wordParts: WordPart[], hasArrayAtExpansion: boolean, expandPart: ExpandPartFn, expandWordPartsAsync: ExpandWordPartsAsyncFn): Promise<ArrayExpansionResult>;
/**
 * Handle "${prefix}${arr[@]}${suffix}" - array expansion with adjacent text in double quotes.
 * Each array element becomes a separate word, with prefix joined to first and suffix joined to last.
 * This is similar to how "$@" works with prefix/suffix.
 */
export declare function handleArrayWithPrefixSuffix(ctx: InterpreterContext, wordParts: WordPart[], hasArrayAtExpansion: boolean, expandPart: ExpandPartFn): Promise<ArrayExpansionResult>;
