/**
 * Array Slicing and Transform Operations
 *
 * Handles array expansion with slicing and transform operators:
 * - "${arr[@]:offset}" and "${arr[@]:offset:length}" - array slicing
 * - "${arr[@]@a}", "${arr[@]@P}", "${arr[@]@Q}" - transform operations
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
import type { ArithExpr } from "../../ast/types.js";
/**
 * Type for evaluateArithmetic function
 */
export type EvaluateArithmeticFn = (ctx: InterpreterContext, expr: ArithExpr, isExpansionContext?: boolean) => Promise<number>;
/**
 * Handle "${arr[@]:offset}" and "${arr[@]:offset:length}" - array slicing with multiple return values
 * "${arr[@]:n:m}" returns m elements starting from index n as separate words
 * "${arr[*]:n:m}" returns m elements starting from index n joined with IFS as one word
 */
export declare function handleArraySlicing(ctx: InterpreterContext, wordParts: WordPart[], evaluateArithmetic: EvaluateArithmeticFn): Promise<ArrayExpansionResult>;
/**
 * Handle "${arr[@]@a}", "${arr[@]@P}", "${arr[@]@Q}" - array Transform operations
 * "${arr[@]@a}": Return attribute letter for each element (e.g., 'a' for indexed array)
 * "${arr[@]@P}": Return each element's value (prompt expansion, limited implementation)
 * "${arr[@]@Q}": Return each element quoted for shell reuse
 * "${arr[*]@X}": Same as above but joined with IFS as one word
 */
export declare function handleArrayTransform(ctx: InterpreterContext, wordParts: WordPart[]): ArrayExpansionResult;
