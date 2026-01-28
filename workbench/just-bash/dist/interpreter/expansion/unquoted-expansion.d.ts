/**
 * Unquoted Expansion Handlers
 *
 * Handles unquoted positional parameter and array expansions:
 * - Unquoted $@ and $* (with and without prefix/suffix)
 * - Unquoted ${arr[@]} and ${arr[*]}
 * - Unquoted ${@:offset} and ${*:offset} slicing
 * - Unquoted ${@#pattern} and ${*#pattern} pattern removal
 * - Unquoted ${arr[@]/pattern/replacement} pattern replacement
 * - Unquoted ${arr[@]#pattern} pattern removal
 * - Unquoted ${!prefix@} and ${!prefix*} variable name prefix expansion
 * - Unquoted ${!arr[@]} and ${!arr[*]} array keys expansion
 */
import type { ArithExpr, WordPart } from "../../ast/types.js";
import type { InterpreterContext } from "../types.js";
/**
 * Result type for unquoted expansion handlers.
 * `null` means the handler doesn't apply to this case.
 */
export type UnquotedExpansionResult = {
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
 * Type for evaluateArithmetic function
 */
export type EvaluateArithmeticFn = (ctx: InterpreterContext, expr: ArithExpr, isExpansionContext?: boolean) => Promise<number>;
/**
 * Handle unquoted ${array[@]/pattern/replacement} - apply to each element
 * This handles ${array[@]/#/prefix} (prepend) and ${array[@]/%/suffix} (append)
 */
export declare function handleUnquotedArrayPatternReplacement(ctx: InterpreterContext, wordParts: WordPart[], expandWordPartsAsync: ExpandWordPartsAsyncFn, expandPart: ExpandPartFn): Promise<UnquotedExpansionResult>;
/**
 * Handle unquoted ${array[@]#pattern} - apply pattern removal to each element
 * This handles ${array[@]#pattern} (strip shortest prefix), ${array[@]##pattern} (strip longest prefix)
 * ${array[@]%pattern} (strip shortest suffix), ${array[@]%%pattern} (strip longest suffix)
 */
export declare function handleUnquotedArrayPatternRemoval(ctx: InterpreterContext, wordParts: WordPart[], expandWordPartsAsync: ExpandWordPartsAsyncFn, expandPart: ExpandPartFn): Promise<UnquotedExpansionResult>;
/**
 * Handle unquoted ${@#pattern} and ${*#pattern} - apply pattern removal to each positional parameter
 * This handles ${@#pattern} (strip shortest prefix), ${@##pattern} (strip longest prefix)
 * ${@%pattern} (strip shortest suffix), ${@%%pattern} (strip longest suffix)
 */
export declare function handleUnquotedPositionalPatternRemoval(ctx: InterpreterContext, wordParts: WordPart[], expandWordPartsAsync: ExpandWordPartsAsyncFn, expandPart: ExpandPartFn): Promise<UnquotedExpansionResult>;
/**
 * Handle unquoted ${@:offset} and ${*:offset} (with potential prefix/suffix)
 */
export declare function handleUnquotedPositionalSlicing(ctx: InterpreterContext, wordParts: WordPart[], evaluateArithmetic: EvaluateArithmeticFn, expandPart: ExpandPartFn): Promise<UnquotedExpansionResult>;
/**
 * Handle unquoted $@ and $* (simple, without operations)
 */
export declare function handleUnquotedSimplePositional(ctx: InterpreterContext, wordParts: WordPart[]): Promise<UnquotedExpansionResult>;
/**
 * Handle unquoted ${arr[@]} and ${arr[*]} (without operations)
 */
export declare function handleUnquotedSimpleArray(ctx: InterpreterContext, wordParts: WordPart[]): Promise<UnquotedExpansionResult>;
/**
 * Handle unquoted ${!prefix@} and ${!prefix*} (variable name prefix expansion)
 */
export declare function handleUnquotedVarNamePrefix(ctx: InterpreterContext, wordParts: WordPart[]): UnquotedExpansionResult;
/**
 * Handle unquoted ${!arr[@]} and ${!arr[*]} (array keys/indices expansion)
 */
export declare function handleUnquotedArrayKeys(ctx: InterpreterContext, wordParts: WordPart[]): UnquotedExpansionResult;
/**
 * Handle unquoted $@ or $* with prefix/suffix (e.g., =$@= or =$*=)
 */
export declare function handleUnquotedPositionalWithPrefixSuffix(ctx: InterpreterContext, wordParts: WordPart[], expandPart: ExpandPartFn): Promise<UnquotedExpansionResult>;
