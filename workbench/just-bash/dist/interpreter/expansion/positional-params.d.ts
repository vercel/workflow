/**
 * Positional Parameter Expansion Handlers
 *
 * Handles $@ and $* expansion with various operations:
 * - "${@:offset}" and "${*:offset}" - slicing
 * - "${@/pattern/replacement}" - pattern replacement
 * - "${@#pattern}" - pattern removal (strip)
 * - "$@" and "$*" with adjacent text
 */
import type { WordPart } from "../../ast/types.js";
import type { InterpreterContext } from "../types.js";
/**
 * Result type for positional parameter expansion handlers.
 * `null` means the handler doesn't apply to this case.
 */
export type PositionalExpansionResult = {
    values: string[];
    quoted: boolean;
} | null;
import type { ArithExpr } from "../../ast/types.js";
/**
 * Type for evaluateArithmetic function
 */
export type EvaluateArithmeticFn = (ctx: InterpreterContext, expr: ArithExpr, isExpansionContext?: boolean) => Promise<number>;
/**
 * Type for expandPart function
 */
export type ExpandPartFn = (ctx: InterpreterContext, part: WordPart) => Promise<string>;
/**
 * Type for expandWordPartsAsync function
 */
export type ExpandWordPartsAsyncFn = (ctx: InterpreterContext, parts: WordPart[]) => Promise<string>;
/**
 * Handle "${@:offset}" and "${*:offset}" with Substring operations inside double quotes
 * "${@:offset}": Each sliced positional parameter becomes a separate word
 * "${*:offset}": All sliced params joined with IFS as ONE word
 */
export declare function handlePositionalSlicing(ctx: InterpreterContext, wordParts: WordPart[], evaluateArithmetic: EvaluateArithmeticFn, expandPart: ExpandPartFn): Promise<PositionalExpansionResult>;
/**
 * Handle "${@/pattern/replacement}" and "${* /pattern/replacement}" with PatternReplacement inside double quotes
 * "${@/pattern/replacement}": Each positional parameter has pattern replaced, each becomes a separate word
 * "${* /pattern/replacement}": All params joined with IFS, pattern replaced, becomes ONE word
 */
export declare function handlePositionalPatternReplacement(ctx: InterpreterContext, wordParts: WordPart[], expandPart: ExpandPartFn, expandWordPartsAsync: ExpandWordPartsAsyncFn): Promise<PositionalExpansionResult>;
/**
 * Handle "${@#pattern}" and "${*#pattern}" - positional parameter pattern removal (strip)
 * "${@#pattern}": Remove shortest matching prefix from each parameter, each becomes a separate word
 * "${@##pattern}": Remove longest matching prefix from each parameter
 * "${@%pattern}": Remove shortest matching suffix from each parameter
 * "${@%%pattern}": Remove longest matching suffix from each parameter
 */
export declare function handlePositionalPatternRemoval(ctx: InterpreterContext, wordParts: WordPart[], expandPart: ExpandPartFn, expandWordPartsAsync: ExpandWordPartsAsyncFn): Promise<PositionalExpansionResult>;
/**
 * Handle "$@" and "$*" with adjacent text inside double quotes, e.g., "-$@-"
 * "$@": Each positional parameter becomes a separate word, with prefix joined to first
 *       and suffix joined to last. If no params, produces nothing (or just prefix+suffix if present)
 * "$*": All params joined with IFS as ONE word. If no params, produces one empty word.
 */
export declare function handleSimplePositionalExpansion(ctx: InterpreterContext, wordParts: WordPart[], expandPart: ExpandPartFn): Promise<PositionalExpansionResult>;
