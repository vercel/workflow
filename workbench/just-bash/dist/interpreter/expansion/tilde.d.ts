/**
 * Tilde Expansion
 *
 * Functions for handling tilde (~) expansion in word expansion.
 */
import type { InterpreterContext } from "../types.js";
/**
 * Apply tilde expansion to a string.
 * Used after brace expansion to handle cases like ~{/src,root} -> ~/src ~root -> /home/user/src /root
 * Only expands ~ at the start of the string followed by / or end of string.
 */
export declare function applyTildeExpansion(ctx: InterpreterContext, value: string): string;
