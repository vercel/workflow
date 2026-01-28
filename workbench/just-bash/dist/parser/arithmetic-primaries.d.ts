/**
 * Helper functions for parsing primary arithmetic expressions
 */
import type { ArithExpr } from "../ast/types.js";
import type { Parser } from "./parser.js";
/**
 * Skip whitespace in arithmetic expression input.
 * Also handles line continuations (backslash followed by newline).
 */
export declare function skipArithWhitespace(input: string, pos: number): number;
/**
 * Assignment operators in arithmetic expressions
 */
export declare const ARITH_ASSIGN_OPS: readonly ["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "|=", "^="];
/**
 * Parse a number string with various bases (decimal, hex, octal, base#num)
 * Returns NaN for invalid numbers.
 */
export declare function parseArithNumber(str: string): number;
/**
 * Parse nested arithmetic expression: $((expr))
 */
export declare function parseNestedArithmetic(parseArithExpr: (p: Parser, input: string, pos: number) => {
    expr: ArithExpr;
    pos: number;
}, p: Parser, input: string, currentPos: number): {
    expr: ArithExpr;
    pos: number;
} | null;
/**
 * Parse ANSI-C quoting: $'...'
 * Returns the numeric value of the string content
 */
export declare function parseAnsiCQuoting(input: string, currentPos: number): {
    expr: ArithExpr;
    pos: number;
} | null;
/**
 * Parse localization quoting: $"..."
 * Returns the numeric value of the string content
 */
export declare function parseLocalizationQuoting(input: string, currentPos: number): {
    expr: ArithExpr;
    pos: number;
} | null;
