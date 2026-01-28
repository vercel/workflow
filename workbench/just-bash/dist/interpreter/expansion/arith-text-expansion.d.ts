/**
 * Arithmetic Text Expansion
 *
 * Functions for expanding variables within arithmetic expression text.
 * This handles the bash behavior where $(( $x * 3 )) with x='1 + 2' should
 * expand to $(( 1 + 2 * 3 )) = 7, not $(( (1+2) * 3 )) = 9.
 */
import type { InterpreterContext } from "../types.js";
/**
 * Expand $var patterns in arithmetic expression text for text substitution.
 * Only expands simple $var patterns, not ${...}, $(()), $(), etc.
 */
export declare function expandDollarVarsInArithText(ctx: InterpreterContext, text: string): Promise<string>;
/**
 * Expand variable references and command substitutions in an array subscript.
 * e.g., "${array[@]}" -> "1 2 3", "$(echo 1)" -> "1"
 * This is needed for associative array subscripts like assoc["${array[@]}"]
 * where the subscript may contain variable or array expansions.
 */
export declare function expandSubscriptForAssocArray(ctx: InterpreterContext, subscript: string): Promise<string>;
