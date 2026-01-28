/**
 * Pattern Removal Helpers
 *
 * Functions for ${var#pattern}, ${var%pattern}, ${!prefix*} etc.
 */
import type { InterpreterContext } from "../types.js";
/**
 * Apply pattern removal (prefix or suffix strip) to a single value.
 * Used by both scalar and vectorized array operations.
 */
export declare function applyPatternRemoval(value: string, regexStr: string, side: "prefix" | "suffix", greedy: boolean): string;
/**
 * Get variable names that match a given prefix.
 * Used for ${!prefix*} and ${!prefix@} expansions.
 * Handles arrays properly - includes array base names from __length markers,
 * excludes internal storage keys like arr_0, arr__length.
 */
export declare function getVarNamesWithPrefix(ctx: InterpreterContext, prefix: string): string[];
