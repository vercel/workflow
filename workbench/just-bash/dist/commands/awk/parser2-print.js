/**
 * AWK Parser Print Context Helpers
 *
 * Handles parsing in print/printf context where > and >> are redirection
 * operators rather than comparison operators.
 */
// Token type values for use in this module
const TokenTypes = {
    LPAREN: "LPAREN",
    RPAREN: "RPAREN",
    QUESTION: "QUESTION",
    NEWLINE: "NEWLINE",
    SEMICOLON: "SEMICOLON",
    RBRACE: "RBRACE",
    COMMA: "COMMA",
    PIPE: "PIPE",
    GT: "GT",
    APPEND: "APPEND",
    AND: "AND",
    OR: "OR",
    ASSIGN: "ASSIGN",
    PLUS_ASSIGN: "PLUS_ASSIGN",
    MINUS_ASSIGN: "MINUS_ASSIGN",
    STAR_ASSIGN: "STAR_ASSIGN",
    SLASH_ASSIGN: "SLASH_ASSIGN",
    PERCENT_ASSIGN: "PERCENT_ASSIGN",
    CARET_ASSIGN: "CARET_ASSIGN",
    RBRACKET: "RBRACKET",
    COLON: "COLON",
    IN: "IN",
    PRINT: "PRINT",
    PRINTF: "PRINTF",
    IDENT: "IDENT",
    LT: "LT",
    LE: "LE",
    GE: "GE",
    EQ: "EQ",
    NE: "NE",
    MATCH: "MATCH",
    NOT_MATCH: "NOT_MATCH",
    NUMBER: "NUMBER",
    STRING: "STRING",
    DOLLAR: "DOLLAR",
    NOT: "NOT",
    MINUS: "MINUS",
    PLUS: "PLUS",
    INCREMENT: "INCREMENT",
    DECREMENT: "DECREMENT",
};
/**
 * Parse a print statement.
 */
export function parsePrintStatement(p) {
    p.expect(TokenTypes.PRINT);
    const args = [];
    // Check for empty print (print $0)
    if (p.check(TokenTypes.NEWLINE) ||
        p.check(TokenTypes.SEMICOLON) ||
        p.check(TokenTypes.RBRACE) ||
        p.check(TokenTypes.PIPE) ||
        p.check(TokenTypes.GT) ||
        p.check(TokenTypes.APPEND)) {
        args.push({ type: "field", index: { type: "number", value: 0 } });
    }
    else {
        // Parse print arguments - use parsePrintArg to stop before > and >>
        // In AWK, > and >> at print level are redirection, not comparison
        args.push(parsePrintArg(p));
        while (p.check(TokenTypes.COMMA)) {
            p.advance();
            args.push(parsePrintArg(p));
        }
    }
    // Check for output redirection
    let output;
    if (p.check(TokenTypes.GT)) {
        p.advance();
        output = { redirect: ">", file: p.parsePrimary() };
    }
    else if (p.check(TokenTypes.APPEND)) {
        p.advance();
        output = { redirect: ">>", file: p.parsePrimary() };
    }
    return { type: "print", args, output };
}
/**
 * Parse a print argument - same as expression but treats > and >> at the TOP LEVEL
 * (not inside ternary) as redirection rather than comparison operators.
 * Supports assignment expressions like: print 9, a=10, 11
 */
function parsePrintArg(p) {
    // For ternary conditions, we need to allow > as comparison
    // Check if there's a ? ahead (indicating ternary) - if so, parse full comparison
    const hasTernary = lookAheadForTernary(p);
    if (hasTernary) {
        // Parse as full ternary with regular comparison (> allowed)
        // Use parsePrintAssignment to support assignment in ternary context
        return parsePrintAssignment(p, true);
    }
    // No ternary - parse without > to leave room for redirection
    return parsePrintAssignment(p, false);
}
/**
 * Parse assignment in print context. Supports a=10, a+=5, etc.
 * @param allowGt Whether to allow > as comparison (true when inside ternary)
 */
function parsePrintAssignment(p, allowGt) {
    const expr = allowGt ? p.parseTernary() : parsePrintOr(p);
    if (p.match(TokenTypes.ASSIGN, TokenTypes.PLUS_ASSIGN, TokenTypes.MINUS_ASSIGN, TokenTypes.STAR_ASSIGN, TokenTypes.SLASH_ASSIGN, TokenTypes.PERCENT_ASSIGN, TokenTypes.CARET_ASSIGN)) {
        const opToken = p.advance();
        const value = parsePrintAssignment(p, allowGt);
        if (expr.type !== "variable" &&
            expr.type !== "field" &&
            expr.type !== "array_access") {
            throw new Error("Invalid assignment target");
        }
        const opMap = {
            "=": "=",
            "+=": "+=",
            "-=": "-=",
            "*=": "*=",
            "/=": "/=",
            "%=": "%=",
            "^=": "^=",
        };
        return {
            type: "assignment",
            operator: opMap[opToken.value],
            target: expr,
            value,
        };
    }
    return expr;
}
/**
 * Look ahead to see if there's a ternary ? operator before the next statement terminator.
 * This tells us whether > is comparison (in ternary condition) or redirection.
 */
function lookAheadForTernary(p) {
    let depth = 0;
    let i = p.pos;
    while (i < p.tokens.length) {
        const token = p.tokens[i];
        // Track parentheses depth
        if (token.type === TokenTypes.LPAREN)
            depth++;
        if (token.type === TokenTypes.RPAREN)
            depth--;
        // Found ? at top level - it's a ternary (even if > came before)
        if (token.type === TokenTypes.QUESTION && depth === 0) {
            return true;
        }
        // Statement terminators - stop looking (no ternary found)
        if (token.type === TokenTypes.NEWLINE ||
            token.type === TokenTypes.SEMICOLON ||
            token.type === TokenTypes.RBRACE ||
            token.type === TokenTypes.COMMA ||
            token.type === TokenTypes.PIPE) {
            return false;
        }
        i++;
    }
    return false;
}
function parsePrintOr(p) {
    let left = parsePrintAnd(p);
    while (p.check(TokenTypes.OR)) {
        p.advance();
        const right = parsePrintAnd(p);
        left = { type: "binary", operator: "||", left, right };
    }
    return left;
}
function parsePrintAnd(p) {
    let left = parsePrintIn(p);
    while (p.check(TokenTypes.AND)) {
        p.advance();
        const right = parsePrintIn(p);
        left = { type: "binary", operator: "&&", left, right };
    }
    return left;
}
function parsePrintIn(p) {
    const left = parsePrintConcatenation(p);
    if (p.check(TokenTypes.IN)) {
        p.advance();
        const arrayName = String(p.expect(TokenTypes.IDENT).value);
        return { type: "in", key: left, array: arrayName };
    }
    return left;
}
function parsePrintConcatenation(p) {
    let left = parsePrintMatch(p);
    // Concatenation is implicit - consecutive expressions without operators
    // For print context, also stop at > and >> (redirection)
    while (canStartExpression(p) && !isPrintConcatTerminator(p)) {
        const right = parsePrintMatch(p);
        left = { type: "binary", operator: " ", left, right };
    }
    return left;
}
function parsePrintMatch(p) {
    let left = parsePrintComparison(p);
    while (p.match(TokenTypes.MATCH, TokenTypes.NOT_MATCH)) {
        const op = p.advance().type === TokenTypes.MATCH ? "~" : "!~";
        const right = parsePrintComparison(p);
        left = { type: "binary", operator: op, left, right };
    }
    return left;
}
/**
 * Like parseComparison but doesn't consume > and >> (for print redirection)
 */
function parsePrintComparison(p) {
    let left = p.parseAddSub();
    // Only handle <, <=, >=, ==, != - NOT > or >> (those are redirection)
    while (p.match(TokenTypes.LT, TokenTypes.LE, TokenTypes.GE, TokenTypes.EQ, TokenTypes.NE)) {
        const opToken = p.advance();
        const right = p.parseAddSub();
        const opMap = {
            "<": "<",
            "<=": "<=",
            ">=": ">=",
            "==": "==",
            "!=": "!=",
        };
        left = {
            type: "binary",
            operator: opMap[opToken.value],
            left,
            right,
        };
    }
    return left;
}
function canStartExpression(p) {
    return p.match(TokenTypes.NUMBER, TokenTypes.STRING, TokenTypes.IDENT, TokenTypes.DOLLAR, TokenTypes.LPAREN, TokenTypes.NOT, TokenTypes.MINUS, TokenTypes.PLUS, TokenTypes.INCREMENT, TokenTypes.DECREMENT);
}
/**
 * Check if the current token terminates concatenation in print context.
 * Similar to isConcatTerminator but also includes > for redirection.
 */
function isPrintConcatTerminator(p) {
    return p.match(
    // Logical operators
    TokenTypes.AND, TokenTypes.OR, TokenTypes.QUESTION, 
    // Assignment operators
    TokenTypes.ASSIGN, TokenTypes.PLUS_ASSIGN, TokenTypes.MINUS_ASSIGN, TokenTypes.STAR_ASSIGN, TokenTypes.SLASH_ASSIGN, TokenTypes.PERCENT_ASSIGN, TokenTypes.CARET_ASSIGN, 
    // Expression terminators
    TokenTypes.COMMA, TokenTypes.SEMICOLON, TokenTypes.NEWLINE, TokenTypes.RBRACE, TokenTypes.RPAREN, TokenTypes.RBRACKET, TokenTypes.COLON, 
    // Redirection (print-specific)
    TokenTypes.PIPE, TokenTypes.APPEND, TokenTypes.GT, // > is redirection in print context
    // Array membership
    TokenTypes.IN);
}
/**
 * Parse a printf statement.
 */
export function parsePrintfStatement(p) {
    p.expect(TokenTypes.PRINTF);
    // AWK supports both:
    //   printf format, arg1, arg2
    //   printf(format, arg1, arg2)
    // In the parenthesized form, commas are argument separators, NOT the comma operator
    const hasParens = p.check(TokenTypes.LPAREN);
    if (hasParens) {
        p.advance(); // consume (
        // Skip newlines after opening paren (AWK allows multi-line printf)
        p.skipNewlines();
    }
    // Use parsePrintArg to stop at > and >> (for redirection) when not in parens
    // When in parens, we use parseExpression for each argument (stops at , and ))
    const format = hasParens ? p.parseExpression() : parsePrintArg(p);
    const args = [];
    while (p.check(TokenTypes.COMMA)) {
        p.advance();
        // Skip newlines after comma (AWK allows multi-line printf)
        if (hasParens) {
            p.skipNewlines();
        }
        args.push(hasParens ? p.parseExpression() : parsePrintArg(p));
    }
    if (hasParens) {
        // Skip newlines before closing paren
        p.skipNewlines();
        p.expect(TokenTypes.RPAREN);
    }
    // Check for output redirection
    let output;
    if (p.check(TokenTypes.GT)) {
        p.advance();
        output = { redirect: ">", file: p.parsePrimary() };
    }
    else if (p.check(TokenTypes.APPEND)) {
        p.advance();
        output = { redirect: ">>", file: p.parsePrimary() };
    }
    return { type: "printf", format, args, output };
}
