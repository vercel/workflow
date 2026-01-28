/**
 * Tilde expansion helper functions.
 *
 * Handles ~ expansion in assignment contexts.
 */
import type { InterpreterContext } from "../types.js";
/**
 * Expand tildes in assignment values (PATH-like expansion)
 * - ~ at start expands to HOME
 * - ~ after : expands to HOME (for PATH-like values)
 * - ~username expands to user's home (only root supported)
 */
export declare function expandTildesInValue(ctx: InterpreterContext, value: string): string;
