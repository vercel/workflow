/**
 * Moonblade expression tokenizer
 */
export type TokenType = "int" | "float" | "string" | "regex" | "ident" | "true" | "false" | "null" | "(" | ")" | "[" | "]" | "{" | "}" | "," | ":" | ";" | "=>" | "+" | "-" | "*" | "/" | "//" | "%" | "**" | "++" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "&&" | "||" | "and" | "or" | "!" | "." | "|" | "in" | "not in" | "as" | "=" | "_" | "eof";
export interface Token {
    type: TokenType;
    value: string;
    pos: number;
}
export declare class Tokenizer {
    private input;
    private pos;
    private tokens;
    constructor(input: string);
    tokenize(): Token[];
    private skipWhitespace;
    private nextToken;
    private match;
    private isIdentStart;
    private isIdentChar;
    private readNumber;
    private readString;
    private readRegex;
    private readIdentifier;
}
