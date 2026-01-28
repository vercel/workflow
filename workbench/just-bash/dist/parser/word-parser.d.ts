/**
 * Word Parsing Utilities
 *
 * String manipulation utilities for parsing words, expansions, and patterns.
 * These are pure functions extracted from the Parser class.
 */
import { type ArithmeticExpressionNode, type RedirectionOperator, type WordNode, type WordPart } from "../ast/types.js";
import { TokenType } from "./lexer.js";
import type { Parser } from "./parser.js";
export declare function findTildeEnd(_p: Parser, value: string, start: number): number;
export declare function findMatchingBracket(_p: Parser, value: string, start: number, open: string, close: string): number;
export declare function findParameterOperationEnd(_p: Parser, value: string, start: number): number;
export declare function findPatternEnd(_p: Parser, value: string, start: number): number;
export declare function parseGlobPattern(_p: Parser, value: string, start: number): {
    pattern: string;
    endIndex: number;
};
export declare function parseAnsiCQuoted(_p: Parser, value: string, start: number): {
    part: WordPart;
    endIndex: number;
};
export declare function parseArithExprFromString(p: Parser, str: string): ArithmeticExpressionNode;
export type WordPartsParser = (p: Parser, value: string, quoted?: boolean, singleQuoted?: boolean, isAssignment?: boolean) => WordPart[];
export declare function tryParseBraceExpansion(p: Parser, value: string, start: number, parseWordPartsFn?: WordPartsParser): {
    part: WordPart;
    endIndex: number;
} | null;
/**
 * Convert a WordNode back to a string representation.
 * Used for reconstructing array assignment strings for declare/local.
 */
export declare function wordToString(_p: Parser, word: WordNode): string;
export declare function tokenToRedirectOp(_p: Parser, type: TokenType): RedirectionOperator;
