/**
 * Word Expansion with Glob Handling
 *
 * Handles the main word expansion flow including:
 * - Brace expansion
 * - Array and positional parameter expansion
 * - Word splitting
 * - Glob/pathname expansion
 */
import type { ArithExpr, ParameterExpansionPart, WordNode, WordPart } from "../../ast/types.js";
import type { InterpreterContext } from "../types.js";
/**
 * Dependencies injected to avoid circular imports
 */
export interface WordGlobExpansionDeps {
    expandWordAsync: (ctx: InterpreterContext, word: WordNode) => Promise<string>;
    expandWordForGlobbing: (ctx: InterpreterContext, word: WordNode) => Promise<string>;
    expandWordWithBracesAsync: (ctx: InterpreterContext, word: WordNode) => Promise<string[] | null>;
    expandWordPartsAsync: (ctx: InterpreterContext, parts: WordPart[]) => Promise<string>;
    expandPart: (ctx: InterpreterContext, part: WordPart, inDoubleQuotes?: boolean) => Promise<string>;
    expandParameterAsync: (ctx: InterpreterContext, part: ParameterExpansionPart, inDoubleQuotes?: boolean) => Promise<string>;
    hasBraceExpansion: (parts: WordPart[]) => boolean;
    evaluateArithmetic: (ctx: InterpreterContext, expr: ArithExpr, isExpansionContext?: boolean) => Promise<number>;
    buildIfsCharClassPattern: (ifsChars: string) => string;
    smartWordSplit: (ctx: InterpreterContext, wordParts: WordPart[], ifsChars: string, ifsPattern: string, expandPart: (ctx: InterpreterContext, part: WordPart) => Promise<string>) => Promise<string[]>;
}
/**
 * Main word expansion function that handles all expansion types and glob matching.
 */
export declare function expandWordWithGlobImpl(ctx: InterpreterContext, word: WordNode, deps: WordGlobExpansionDeps): Promise<{
    values: string[];
    quoted: boolean;
}>;
