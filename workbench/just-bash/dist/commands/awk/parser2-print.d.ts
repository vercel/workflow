/**
 * AWK Parser Print Context Helpers
 *
 * Handles parsing in print/printf context where > and >> are redirection
 * operators rather than comparison operators.
 */
import type { AwkExpr, AwkStmt } from "./ast.js";
import type { Token, TokenType } from "./lexer.js";
/**
 * Interface for parser methods needed by print parsing helpers.
 * Used to avoid circular dependencies.
 */
export interface PrintParserContext {
    tokens: Token[];
    pos: number;
    current(): Token;
    advance(): Token;
    match(...types: TokenType[]): boolean;
    check(type: TokenType): boolean;
    expect(type: TokenType, message?: string): Token;
    skipNewlines(): void;
    parseExpression(): AwkExpr;
    parseTernary(): AwkExpr;
    parsePrimary(): AwkExpr;
    parseAddSub(): AwkExpr;
    setPos(pos: number): void;
}
/**
 * Parse a print statement.
 */
export declare function parsePrintStatement(p: PrintParserContext): AwkStmt;
/**
 * Parse a printf statement.
 */
export declare function parsePrintfStatement(p: PrintParserContext): AwkStmt;
