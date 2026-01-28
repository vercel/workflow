/**
 * AWK Lexer
 *
 * Tokenizes AWK source code into a stream of tokens.
 */
export declare enum TokenType {
    NUMBER = "NUMBER",
    STRING = "STRING",
    REGEX = "REGEX",
    IDENT = "IDENT",
    BEGIN = "BEGIN",
    END = "END",
    IF = "IF",
    ELSE = "ELSE",
    WHILE = "WHILE",
    DO = "DO",
    FOR = "FOR",
    IN = "IN",
    BREAK = "BREAK",
    CONTINUE = "CONTINUE",
    NEXT = "NEXT",
    NEXTFILE = "NEXTFILE",
    EXIT = "EXIT",
    RETURN = "RETURN",
    DELETE = "DELETE",
    FUNCTION = "FUNCTION",
    PRINT = "PRINT",
    PRINTF = "PRINTF",
    GETLINE = "GETLINE",
    PLUS = "PLUS",
    MINUS = "MINUS",
    STAR = "STAR",
    SLASH = "SLASH",
    PERCENT = "PERCENT",
    CARET = "CARET",
    EQ = "EQ",
    NE = "NE",
    LT = "LT",
    GT = "GT",
    LE = "LE",
    GE = "GE",
    MATCH = "MATCH",
    NOT_MATCH = "NOT_MATCH",
    AND = "AND",
    OR = "OR",
    NOT = "NOT",
    ASSIGN = "ASSIGN",
    PLUS_ASSIGN = "PLUS_ASSIGN",
    MINUS_ASSIGN = "MINUS_ASSIGN",
    STAR_ASSIGN = "STAR_ASSIGN",
    SLASH_ASSIGN = "SLASH_ASSIGN",
    PERCENT_ASSIGN = "PERCENT_ASSIGN",
    CARET_ASSIGN = "CARET_ASSIGN",
    INCREMENT = "INCREMENT",
    DECREMENT = "DECREMENT",
    QUESTION = "QUESTION",
    COLON = "COLON",
    COMMA = "COMMA",
    SEMICOLON = "SEMICOLON",
    NEWLINE = "NEWLINE",
    LPAREN = "LPAREN",
    RPAREN = "RPAREN",
    LBRACE = "LBRACE",
    RBRACE = "RBRACE",
    LBRACKET = "LBRACKET",
    RBRACKET = "RBRACKET",
    DOLLAR = "DOLLAR",
    APPEND = "APPEND",
    PIPE = "PIPE",
    EOF = "EOF"
}
export interface Token {
    type: TokenType;
    value: string | number;
    line: number;
    column: number;
}
export declare class AwkLexer {
    private input;
    private pos;
    private line;
    private column;
    private lastTokenType;
    constructor(input: string);
    tokenize(): Token[];
    private makeToken;
    private peek;
    private advance;
    private skipWhitespace;
    private nextToken;
    private canBeRegex;
    private readString;
    private readRegex;
    private readNumber;
    private readIdentifier;
    private readOperator;
    private isDigit;
    private isAlpha;
    private isAlphaNumeric;
}
