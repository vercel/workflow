/**
 * AWK Parser
 *
 * Recursive descent parser that builds an AST from tokens.
 */
import type { AwkExpr, AwkProgram } from "./ast.js";
import { type Token, TokenType } from "./lexer.js";
export declare class AwkParser {
    tokens: Token[];
    pos: number;
    parse(input: string): AwkProgram;
    setPos(newPos: number): void;
    current(): Token;
    advance(): Token;
    match(...types: TokenType[]): boolean;
    check(type: TokenType): boolean;
    expect(type: TokenType, message?: string): Token;
    skipNewlines(): void;
    private skipTerminators;
    private parseProgram;
    private parseFunction;
    private parseRule;
    private parseBlock;
    private parseStatement;
    private parseIf;
    private parseWhile;
    private parseDoWhile;
    private parseFor;
    parseExpression(): AwkExpr;
    private parseAssignment;
    parseTernary(): AwkExpr;
    /**
     * Parse command pipe getline: "cmd" | getline [var]
     * This has lower precedence than logical OR but higher than ternary.
     */
    private parsePipeGetline;
    private parseOr;
    /**
     * Continue parsing a logical OR/AND expression from a given left-hand side.
     * Used when we've already parsed part of an expression (e.g., a regex in pattern context).
     */
    private parseLogicalOrRest;
    /**
     * Continue parsing a logical AND expression from a given left-hand side.
     */
    private parseLogicalAndRest;
    private parseAnd;
    private parseIn;
    private parseConcatenation;
    private parseMatch;
    private parseComparison;
    private canStartExpression;
    /**
     * Check if the current token terminates a concatenation.
     * These are tokens that indicate we've reached a higher-level operator
     * or end of expression.
     */
    private isConcatTerminator;
    parseAddSub(): AwkExpr;
    private parseMulDiv;
    private parseUnary;
    private parsePower;
    private parsePostfix;
    /**
     * Parse a field index expression. This is like parseUnary but does NOT allow
     * postfix operators, so that $i++ parses as ($i)++ rather than $(i++).
     * Allows: $1, $i, $++i, $--i, $(expr), $-1
     * Does NOT consume postfix ++ or -- (those apply to the field, not the index)
     */
    private parseFieldIndex;
    /**
     * Parse power expression for field index (no postfix on base)
     */
    private parseFieldIndexPower;
    /**
     * Parse primary expression for field index - like parsePrimary but returns
     * without checking for postfix operators
     */
    private parseFieldIndexPrimary;
    parsePrimary(): AwkExpr;
}
