/**
 * Parameter Operation Handlers
 *
 * Handles individual parameter expansion operations:
 * - DefaultValue, AssignDefault, UseAlternative, ErrorIfUnset
 * - PatternRemoval, PatternReplacement
 * - Length, Substring
 * - CaseModification, Transform
 * - Indirection, ArrayKeys, VarNamePrefix
 */
import type { CaseModificationOp, ErrorIfUnsetOp, InnerParameterOperation, ParameterExpansionPart, PatternRemovalOp, PatternReplacementOp, SubstringOp, WordNode, WordPart } from "../../ast/types.js";
import type { InterpreterContext } from "../types.js";
/**
 * Type for expandWordPartsAsync function reference
 */
export type ExpandWordPartsAsyncFn = (ctx: InterpreterContext, parts: WordPart[], inDoubleQuotes?: boolean) => Promise<string>;
/**
 * Type for expandPart function reference
 */
export type ExpandPartFn = (ctx: InterpreterContext, part: WordPart, inDoubleQuotes?: boolean) => Promise<string>;
/**
 * Type for self-reference to expandParameterAsync
 */
export type ExpandParameterAsyncFn = (ctx: InterpreterContext, part: ParameterExpansionPart, inDoubleQuotes?: boolean) => Promise<string>;
/**
 * Context with computed values used across multiple operation handlers
 */
export interface ParameterOpContext {
    value: string;
    isUnset: boolean;
    isEmpty: boolean;
    effectiveValue: string;
    inDoubleQuotes: boolean;
}
/**
 * Handle DefaultValue operation: ${param:-word}
 */
export declare function handleDefaultValue(ctx: InterpreterContext, operation: {
    word?: WordNode;
    checkEmpty?: boolean;
}, opCtx: ParameterOpContext, expandWordPartsAsync: ExpandWordPartsAsyncFn): Promise<string>;
/**
 * Handle AssignDefault operation: ${param:=word}
 */
export declare function handleAssignDefault(ctx: InterpreterContext, parameter: string, operation: {
    word?: WordNode;
    checkEmpty?: boolean;
}, opCtx: ParameterOpContext, expandWordPartsAsync: ExpandWordPartsAsyncFn): Promise<string>;
/**
 * Handle ErrorIfUnset operation: ${param:?word}
 */
export declare function handleErrorIfUnset(ctx: InterpreterContext, parameter: string, operation: ErrorIfUnsetOp, opCtx: ParameterOpContext, expandWordPartsAsync: ExpandWordPartsAsyncFn): Promise<string>;
/**
 * Handle UseAlternative operation: ${param:+word}
 */
export declare function handleUseAlternative(ctx: InterpreterContext, operation: {
    word?: WordNode;
    checkEmpty?: boolean;
}, opCtx: ParameterOpContext, expandWordPartsAsync: ExpandWordPartsAsyncFn): Promise<string>;
/**
 * Handle PatternRemoval operation: ${param#pattern}, ${param%pattern}
 */
export declare function handlePatternRemoval(ctx: InterpreterContext, value: string, operation: PatternRemovalOp, expandWordPartsAsync: ExpandWordPartsAsyncFn, expandPart: ExpandPartFn): Promise<string>;
/**
 * Handle PatternReplacement operation: ${param/pattern/replacement}
 */
export declare function handlePatternReplacement(ctx: InterpreterContext, value: string, operation: PatternReplacementOp, expandWordPartsAsync: ExpandWordPartsAsyncFn, expandPart: ExpandPartFn): Promise<string>;
/**
 * Handle Length operation: ${#param}
 */
export declare function handleLength(ctx: InterpreterContext, parameter: string, value: string): string;
/**
 * Handle Substring operation: ${param:offset:length}
 */
export declare function handleSubstring(ctx: InterpreterContext, parameter: string, value: string, operation: SubstringOp): Promise<string>;
/**
 * Handle CaseModification operation: ${param^pattern}, ${param,pattern}
 */
export declare function handleCaseModification(ctx: InterpreterContext, value: string, operation: CaseModificationOp, expandWordPartsAsync: ExpandWordPartsAsyncFn, expandParameterAsync: ExpandParameterAsyncFn): Promise<string>;
/**
 * Handle Transform operation: ${param@operator}
 */
export declare function handleTransform(ctx: InterpreterContext, parameter: string, value: string, isUnset: boolean, operation: {
    operator: string;
}): string;
/**
 * Handle Indirection operation: ${!param}
 */
export declare function handleIndirection(ctx: InterpreterContext, parameter: string, value: string, isUnset: boolean, operation: {
    innerOp?: InnerParameterOperation;
}, expandParameterAsync: ExpandParameterAsyncFn, inDoubleQuotes?: boolean): Promise<string>;
/**
 * Handle ArrayKeys operation: ${!arr[@]}, ${!arr[*]}
 */
export declare function handleArrayKeys(ctx: InterpreterContext, operation: {
    array: string;
    star: boolean;
}): string;
/**
 * Handle VarNamePrefix operation: ${!prefix*}, ${!prefix@}
 */
export declare function handleVarNamePrefix(ctx: InterpreterContext, operation: {
    prefix: string;
    star: boolean;
}): string;
/**
 * Compute whether the parameter value is "empty" for expansion purposes.
 * This handles special cases for $*, $@, array[*], and array[@].
 */
export declare function computeIsEmpty(ctx: InterpreterContext, parameter: string, value: string, inDoubleQuotes: boolean): {
    isEmpty: boolean;
    effectiveValue: string;
};
