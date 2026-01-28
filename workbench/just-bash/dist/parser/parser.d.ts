/**
 * Recursive Descent Parser for Bash Scripts
 *
 * This parser consumes tokens from the lexer and produces an AST.
 * It follows the bash grammar structure for correctness.
 *
 * Grammar (simplified):
 *   script       ::= statement*
 *   statement    ::= pipeline ((&&|'||') pipeline)*  [&]
 *   pipeline     ::= [!] command (| command)*
 *   command      ::= simple_command | compound_command | function_def
 *   simple_cmd   ::= (assignment)* [word] (word)* (redirection)*
 *   compound_cmd ::= if | for | while | until | case | subshell | group | (( | [[
 */
import { type ArithmeticExpansionPart, type ArithmeticExpressionNode, type CommandSubstitutionPart, type RedirectionNode, type ScriptNode, type StatementNode, type WordNode } from "../ast/types.js";
import { type Token, TokenType } from "./lexer.js";
export type { ParseError } from "./types.js";
export { ParseException } from "./types.js";
/**
 * Parser class - transforms tokens into AST
 */
export declare class Parser {
    private tokens;
    private pos;
    private pendingHeredocs;
    private parseIterations;
    private _input;
    /**
     * Get the raw input string being parsed.
     * Used by conditional-parser for extracting exact whitespace in regex patterns.
     */
    getInput(): string;
    /**
     * Check parse iteration limit to prevent infinite loops
     */
    checkIterationLimit(): void;
    /**
     * Parse a bash script string
     */
    parse(input: string): ScriptNode;
    /**
     * Parse from pre-tokenized input
     */
    parseTokens(tokens: Token[]): ScriptNode;
    current(): Token;
    peek(offset?: number): Token;
    advance(): Token;
    getPos(): number;
    /**
     * Check if current token matches any of the given types.
     * Optimized to avoid array allocation for common cases (1-4 args).
     */
    check(t1: TokenType, t2?: TokenType, t3?: TokenType, t4?: TokenType, ...rest: TokenType[]): boolean;
    expect(type: TokenType, message?: string): Token;
    error(message: string): never;
    skipNewlines(): void;
    skipSeparators(includeCaseTerminators?: boolean): void;
    addPendingHeredoc(redirect: RedirectionNode, delimiter: string, stripTabs: boolean, quoted: boolean): void;
    private processHeredocs;
    isStatementEnd(): boolean;
    private isCommandStart;
    private parseScript;
    /**
     * Check for unexpected tokens that can't appear at statement start.
     * Returns a deferred error statement for tokens that should cause errors
     * at execution time rather than parse time (to match bash's incremental behavior).
     */
    private checkUnexpectedToken;
    parseStatement(): StatementNode | null;
    private parsePipeline;
    private parseCommand;
    /**
     * Scan ahead from current DPAREN_START to determine if it closes with ) )
     * (two separate RPAREN tokens) or )) (DPAREN_END token).
     * Returns true if it closes with ) ) (nested subshells case).
     */
    private dparenClosesWithSpacedParens;
    /**
     * Parse (( ... ) ) as nested subshells when we know it closes with ) ).
     * We've already determined via dparenClosesWithSpacedParens() that this
     * DPAREN_START should be treated as two LPAREN tokens.
     */
    private parseNestedSubshellsFromDparen;
    isWord(): boolean;
    parseWord(): WordNode;
    /**
     * Parse a word without brace expansion (for [[ ]] conditionals).
     * In bash, brace expansion does not occur inside [[ ]].
     */
    parseWordNoBraceExpansion(): WordNode;
    /**
     * Parse a word for regex patterns (in [[ =~ ]]).
     * All escaped characters create Escaped nodes so the backslash is preserved
     * for the regex engine. For example, \$ creates Escaped("$") which becomes \$
     * in the final regex pattern.
     */
    parseWordForRegex(): WordNode;
    parseWordFromString(value: string, quoted?: boolean, singleQuoted?: boolean, isAssignment?: boolean, hereDoc?: boolean, noBraceExpansion?: boolean, regexPattern?: boolean): WordNode;
    parseCommandSubstitution(value: string, start: number): {
        part: CommandSubstitutionPart;
        endIndex: number;
    };
    parseBacktickSubstitution(value: string, start: number, 
    /** Whether the backtick is inside double quotes */
    inDoubleQuotes?: boolean): {
        part: CommandSubstitutionPart;
        endIndex: number;
    };
    /**
     * Check if $(( at position `start` in `value` is a command substitution with nested
     * subshell rather than arithmetic expansion.
     */
    isDollarDparenSubshell(value: string, start: number): boolean;
    parseArithmeticExpansion(value: string, start: number): {
        part: ArithmeticExpansionPart;
        endIndex: number;
    };
    private parseArithmeticCommand;
    private parseConditionalCommand;
    private parseFunctionDef;
    private parseCompoundCommandBody;
    parseCompoundList(): StatementNode[];
    parseOptionalRedirections(): RedirectionNode[];
    parseArithmeticExpression(input: string): ArithmeticExpressionNode;
}
/**
 * Convenience function to parse a bash script
 */
export declare function parse(input: string): ScriptNode;
