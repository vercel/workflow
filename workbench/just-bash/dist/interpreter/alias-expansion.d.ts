/**
 * Alias Expansion
 *
 * Handles bash alias expansion for SimpleCommandNodes.
 *
 * Alias expansion rules:
 * 1. Only expands if command name is a literal unquoted word
 * 2. Alias value is substituted for the command name
 * 3. If alias value ends with a space, the next word is also checked for alias expansion
 * 4. Recursive expansion is allowed but limited to prevent infinite loops
 */
import type { SimpleCommandNode } from "../ast/types.js";
/**
 * Context needed for alias expansion operations
 */
export interface AliasExpansionContext {
    env: Record<string, string | undefined>;
}
/**
 * Expand alias in a SimpleCommandNode if applicable.
 * Returns a new node with the alias expanded, or the original node if no expansion.
 */
export declare function expandAlias(ctx: AliasExpansionContext, node: SimpleCommandNode, aliasExpansionStack: Set<string>): SimpleCommandNode;
