/**
 * Lexer for Bash Scripts
 *
 * The lexer tokenizes input into a stream of tokens that the parser consumes.
 * It handles:
 * - Operators and delimiters
 * - Words (with quoting rules)
 * - Comments
 * - Here-documents
 * - Escape sequences
 */
export declare enum TokenType {
    EOF = "EOF",
    NEWLINE = "NEWLINE",
    SEMICOLON = "SEMICOLON",
    AMP = "AMP",// &
    PIPE = "PIPE",// |
    PIPE_AMP = "PIPE_AMP",// |&
    AND_AND = "AND_AND",// &&
    OR_OR = "OR_OR",// ||
    BANG = "BANG",// !
    LESS = "LESS",// <
    GREAT = "GREAT",// >
    DLESS = "DLESS",// <<
    DGREAT = "DGREAT",// >>
    LESSAND = "LESSAND",// <&
    GREATAND = "GREATAND",// >&
    LESSGREAT = "LESSGREAT",// <>
    DLESSDASH = "DLESSDASH",// <<-
    CLOBBER = "CLOBBER",// >|
    TLESS = "TLESS",// <<<
    AND_GREAT = "AND_GREAT",// &>
    AND_DGREAT = "AND_DGREAT",// &>>
    LPAREN = "LPAREN",// (
    RPAREN = "RPAREN",// )
    LBRACE = "LBRACE",// {
    RBRACE = "RBRACE",// }
    DSEMI = "DSEMI",// ;;
    SEMI_AND = "SEMI_AND",// ;&
    SEMI_SEMI_AND = "SEMI_SEMI_AND",// ;;&
    DBRACK_START = "DBRACK_START",// [[
    DBRACK_END = "DBRACK_END",// ]]
    DPAREN_START = "DPAREN_START",// ((
    DPAREN_END = "DPAREN_END",// ))
    IF = "IF",
    THEN = "THEN",
    ELSE = "ELSE",
    ELIF = "ELIF",
    FI = "FI",
    FOR = "FOR",
    WHILE = "WHILE",
    UNTIL = "UNTIL",
    DO = "DO",
    DONE = "DONE",
    CASE = "CASE",
    ESAC = "ESAC",
    IN = "IN",
    FUNCTION = "FUNCTION",
    SELECT = "SELECT",
    TIME = "TIME",
    COPROC = "COPROC",
    WORD = "WORD",
    NAME = "NAME",// Valid variable name
    NUMBER = "NUMBER",// For redirections like 2>&1
    ASSIGNMENT_WORD = "ASSIGNMENT_WORD",// VAR=value
    FD_VARIABLE = "FD_VARIABLE",// {varname} before redirect operator
    COMMENT = "COMMENT",
    HEREDOC_CONTENT = "HEREDOC_CONTENT"
}
export interface Token {
    type: TokenType;
    value: string;
    /** Original position in input */
    start: number;
    end: number;
    line: number;
    column: number;
    /** For WORD tokens: quote information */
    quoted?: boolean;
    singleQuoted?: boolean;
}
/**
 * Error thrown when the lexer encounters invalid input
 */
export declare class LexerError extends Error {
    line: number;
    column: number;
    constructor(message: string, line: number, column: number);
}
/**
 * Lexer class
 */
export declare class Lexer {
    private input;
    private pos;
    private line;
    private column;
    private tokens;
    private pendingHeredocs;
    private dparenDepth;
    constructor(input: string);
    /**
     * Tokenize the entire input
     */
    tokenize(): Token[];
    private skipWhitespace;
    private nextToken;
    /**
     * Look ahead from position after (( to determine if this is nested subshells
     * like ((cmd) || (cmd2)) rather than arithmetic like ((1+2)).
     *
     * Returns true if it looks like nested subshells (command invocation).
     */
    private looksLikeNestedSubshells;
    private makeToken;
    private readComment;
    private readWord;
    private readHeredocContent;
    /**
     * Register a here-document to be read after the next newline
     */
    addPendingHeredoc(delimiter: string, stripTabs: boolean, quoted: boolean): void;
    /**
     * Look ahead from current position to find the here-doc delimiter
     * and register it as a pending here-doc
     */
    private registerHeredocFromLookahead;
    /**
     * Check if position is followed by word characters (not a word boundary).
     * Used to determine if } should be literal or RBRACE token.
     */
    private isWordCharFollowing;
    /**
     * Read a word that starts with a brace expansion.
     * Includes the brace expansion plus any suffix characters and additional brace expansions.
     */
    private readWordWithBraceExpansion;
    /**
     * Scan ahead to detect brace expansion pattern.
     * Returns the full brace expansion string if found, null otherwise.
     * Brace expansion must contain either:
     * - A comma (e.g., {a,b,c})
     * - A range with .. (e.g., {1..10})
     */
    private scanBraceExpansion;
    /**
     * Scan a literal brace word like {foo} (no comma, no range).
     * Returns the literal string if found, null otherwise.
     * This is used when {} contains something but it's not a valid brace expansion.
     */
    private scanLiteralBraceWord;
    /**
     * Scan an extglob pattern starting at the opening parenthesis.
     * Extglob patterns are: @(...), *(...), +(...), ?(...), !(...)
     * The operator (@, *, +, ?, !) is already consumed; we start at the (.
     * Returns the content including parentheses, or null if not a valid extglob.
     */
    private scanExtglobPattern;
    /**
     * Scan for FD variable syntax: {varname} immediately followed by a redirect operator.
     * This is the bash 4.1+ feature where {fd}>file allocates an FD and stores it in variable.
     * Returns the variable name and end position if found, null otherwise.
     *
     * Valid patterns:
     * - {varname}>file, {varname}>>file, {varname}>|file
     * - {varname}<file, {varname}<<word, {varname}<<<word
     * - {varname}<>file
     * - {varname}>&N, {varname}<&N
     * - {varname}>&-, {varname}<&- (close FD)
     */
    private scanFdVariable;
    /**
     * Scan ahead from a $(( position to determine if it should be treated as
     * $( ( subshell ) ) instead of $(( arithmetic )).
     * This handles cases like:
     *   echo $(( echo 1
     *   echo 2
     *   ) )
     * which should be a command substitution containing a subshell, not arithmetic.
     *
     * @param startPos - position at the second ( (i.e., at input[startPos] === "(")
     * @returns true if this is a subshell (closes with ) )), false if arithmetic (closes with )))
     */
    private dollarDparenIsSubshell;
    /**
     * Scan ahead from a (( position to determine if it closes with ) ) (nested subshells)
     * or )) (arithmetic). We need to track paren depth and quotes to find the matching close.
     * @param startPos - position after the (( (i.e., at the first char of content)
     * @returns true if it closes with ) ) (space between parens), false otherwise
     */
    private dparenClosesWithSpacedParens;
}
