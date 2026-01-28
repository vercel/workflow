/**
 * Pattern Expansion
 *
 * Functions for expanding variables within glob/extglob patterns.
 * Handles command substitution, variable expansion, and quoting within patterns.
 */
import type { InterpreterContext } from "../types.js";
/**
 * Check if a pattern string contains command substitution $(...)
 */
export declare function patternHasCommandSubstitution(pattern: string): boolean;
/**
 * Expand variables within a glob/extglob pattern string.
 * This handles patterns like @($var|$other) where variables need expansion.
 * Also handles quoted strings inside patterns (e.g., @(foo|'bar'|"$baz")).
 * Preserves pattern metacharacters while expanding $var and ${var} references.
 */
export declare function expandVariablesInPattern(ctx: InterpreterContext, pattern: string): string;
/**
 * Async version of expandVariablesInPattern that handles command substitutions.
 * This handles patterns like @($var|$(echo foo)) where command substitutions need expansion.
 */
export declare function expandVariablesInPatternAsync(ctx: InterpreterContext, pattern: string): Promise<string>;
