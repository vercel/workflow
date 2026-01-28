/**
 * Command and Arithmetic Substitution Parsing Helpers
 *
 * Contains pure string analysis functions and substitution parsing utilities
 * extracted from the main parser.
 */
import { type CommandSubstitutionPart, type ScriptNode } from "../ast/types.js";
/**
 * Type for a parser factory function that creates new parser instances.
 * Used to avoid circular dependencies.
 */
export type ParserFactory = () => {
    parse(input: string): ScriptNode;
};
/**
 * Type for an error reporting function.
 */
export type ErrorFn = (message: string) => never;
/**
 * Check if $(( at position `start` in `value` is a command substitution with nested
 * subshell rather than arithmetic expansion. This uses similar logic to the lexer's
 * dparenClosesWithSpacedParens but operates on a string within a word/expansion.
 *
 * The key heuristics are:
 * 1. If it closes with `) )` (separated by whitespace or content), it's a subshell
 * 2. If at depth 1 we see `||`, `&&`, or single `|`, it's a command context
 * 3. If it closes with `))`, it's arithmetic
 *
 * @param value The string containing the expansion
 * @param start Position of the `$` in `$((` (so `$((` is at start..start+2)
 * @returns true if this should be parsed as command substitution, false for arithmetic
 */
export declare function isDollarDparenSubshell(value: string, start: number): boolean;
/**
 * Parse a command substitution starting at the given position.
 * Handles $(...) syntax with proper depth tracking for nested substitutions.
 *
 * @param value The string containing the substitution
 * @param start Position of the `$` in `$(`
 * @param createParser Factory function to create a new parser instance
 * @param error Error reporting function
 * @returns The parsed command substitution part and the ending index
 */
export declare function parseCommandSubstitutionFromString(value: string, start: number, createParser: ParserFactory, error: ErrorFn): {
    part: CommandSubstitutionPart;
    endIndex: number;
};
/**
 * Parse a backtick command substitution starting at the given position.
 * Handles `...` syntax with proper escape processing.
 *
 * @param value The string containing the substitution
 * @param start Position of the opening backtick
 * @param inDoubleQuotes Whether the backtick is inside double quotes
 * @param createParser Factory function to create a new parser instance
 * @param error Error reporting function
 * @returns The parsed command substitution part and the ending index
 */
export declare function parseBacktickSubstitutionFromString(value: string, start: number, inDoubleQuotes: boolean, createParser: ParserFactory, error: ErrorFn): {
    part: CommandSubstitutionPart;
    endIndex: number;
};
