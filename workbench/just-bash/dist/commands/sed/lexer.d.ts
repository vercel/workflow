/**
 * SED Lexer
 *
 * Tokenizes sed scripts into a stream of tokens.
 * Sed has context-sensitive tokenization - the meaning of characters
 * depends heavily on what command is being parsed.
 */
export declare enum SedTokenType {
    NUMBER = "NUMBER",
    DOLLAR = "DOLLAR",// $ - last line
    PATTERN = "PATTERN",// /regex/
    STEP = "STEP",// first~step
    RELATIVE_OFFSET = "RELATIVE_OFFSET",// +N (GNU extension: ,+N range)
    LBRACE = "LBRACE",// {
    RBRACE = "RBRACE",// }
    SEMICOLON = "SEMICOLON",// ;
    NEWLINE = "NEWLINE",
    COMMA = "COMMA",// , - address range separator
    NEGATION = "NEGATION",// ! - negate address
    COMMAND = "COMMAND",// p, d, h, H, g, G, x, n, N, P, D, q, Q, z, =, l, F, v
    SUBSTITUTE = "SUBSTITUTE",// s/pattern/replacement/flags
    TRANSLITERATE = "TRANSLITERATE",// y/source/dest/
    LABEL_DEF = "LABEL_DEF",// :name
    BRANCH = "BRANCH",// b [label]
    BRANCH_ON_SUBST = "BRANCH_ON_SUBST",// t [label]
    BRANCH_ON_NO_SUBST = "BRANCH_ON_NO_SUBST",// T [label]
    TEXT_CMD = "TEXT_CMD",// a\, i\, c\ with text
    FILE_READ = "FILE_READ",// r filename
    FILE_READ_LINE = "FILE_READ_LINE",// R filename
    FILE_WRITE = "FILE_WRITE",// w filename
    FILE_WRITE_LINE = "FILE_WRITE_LINE",// W filename
    EXECUTE = "EXECUTE",// e [command]
    VERSION = "VERSION",// v [version]
    EOF = "EOF",
    ERROR = "ERROR"
}
export interface SedToken {
    type: SedTokenType;
    value: string | number;
    pattern?: string;
    replacement?: string;
    flags?: string;
    source?: string;
    dest?: string;
    text?: string;
    label?: string;
    filename?: string;
    command?: string;
    first?: number;
    step?: number;
    offset?: number;
    line: number;
    column: number;
}
export declare class SedLexer {
    private input;
    private pos;
    private line;
    private column;
    constructor(input: string);
    tokenize(): SedToken[];
    private makeToken;
    private peek;
    private advance;
    /**
     * Read an escaped string until the delimiter is reached.
     * Handles escape sequences: \n -> newline, \t -> tab, \X -> X
     * Returns null if newline is encountered before delimiter.
     */
    private readEscapedString;
    private skipWhitespace;
    private nextToken;
    private readNumber;
    private readRelativeOffset;
    private readPattern;
    private readLabelDef;
    private readCommand;
    private readSubstitute;
    private readTransliterate;
    private readTextCommand;
    private readBranch;
    private readVersion;
    private readFileCommand;
    private readExecute;
    private isDigit;
}
