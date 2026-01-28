/**
 * Abstract Syntax Tree (AST) Types for Bash
 *
 * This module defines the complete AST structure for bash scripts.
 * The design follows the actual bash grammar while being TypeScript-idiomatic.
 *
 * Architecture:
 *   Input → Lexer → Parser → AST → Expander → Interpreter → Output
 *
 * Each node type corresponds to a bash construct and can be visited
 * by the tree-walking interpreter.
 */
/** Base interface for all AST nodes */
export interface ASTNode {
    type: string;
    /** Source line number (1-based) for $LINENO tracking. May be 0 or undefined for synthesized nodes. */
    line?: number;
}
/** Position information for error reporting */
export interface Position {
    line: number;
    column: number;
    offset: number;
}
/** Span in source code */
export interface Span {
    start: Position;
    end: Position;
}
/** Root node: a complete script */
export interface ScriptNode extends ASTNode {
    type: "Script";
    statements: StatementNode[];
}
/** A statement is a list of pipelines connected by && or || */
export interface StatementNode extends ASTNode {
    type: "Statement";
    pipelines: PipelineNode[];
    /** Operators between pipelines: "&&" | "||" | ";" */
    operators: ("&&" | "||" | ";")[];
    /** Run in background? */
    background: boolean;
    /**
     * Deferred syntax error. If set, executing this statement will throw a syntax error.
     * This is used to support bash's incremental parsing behavior where syntax errors
     * on later lines only trigger if/when execution reaches that line.
     * Example: `{ls;\n}` - the } is invalid but with errexit, the script exits before reaching it.
     */
    deferredError?: {
        message: string;
        token: string;
    };
    /**
     * Original source text for verbose mode (set -v).
     * When verbose mode is enabled, this text is printed to stderr before execution.
     */
    sourceText?: string;
}
/** A pipeline: cmd1 | cmd2 | cmd3 */
export interface PipelineNode extends ASTNode {
    type: "Pipeline";
    commands: CommandNode[];
    /** Negate exit status with ! */
    negated: boolean;
    /** Time the pipeline with 'time' keyword */
    timed?: boolean;
    /** Use POSIX format for time output (-p flag) */
    timePosix?: boolean;
    /**
     * For each pipe in the pipeline, whether it's |& (pipe stderr too).
     * pipeStderr[i] indicates if command[i]'s stderr should be piped to command[i+1]'s stdin.
     * Length is commands.length - 1.
     */
    pipeStderr?: boolean[];
}
/** Union of all command types */
export type CommandNode = SimpleCommandNode | CompoundCommandNode | FunctionDefNode;
/** Simple command: name args... with optional redirections */
export interface SimpleCommandNode extends ASTNode {
    type: "SimpleCommand";
    /** Variable assignments before command: VAR=value cmd */
    assignments: AssignmentNode[];
    /** Command name (may be empty for assignment-only) */
    name: WordNode | null;
    /** Command arguments */
    args: WordNode[];
    /** I/O redirections */
    redirections: RedirectionNode[];
}
/** Compound commands: control structures */
export type CompoundCommandNode = IfNode | ForNode | CStyleForNode | WhileNode | UntilNode | CaseNode | SubshellNode | GroupNode | ArithmeticCommandNode | ConditionalCommandNode;
/** if statement */
export interface IfNode extends ASTNode {
    type: "If";
    clauses: IfClause[];
    elseBody: StatementNode[] | null;
    redirections: RedirectionNode[];
}
export interface IfClause {
    condition: StatementNode[];
    body: StatementNode[];
}
/** for loop: for VAR in WORDS; do ...; done */
export interface ForNode extends ASTNode {
    type: "For";
    variable: string;
    /** Words to iterate over (null = "$@") */
    words: WordNode[] | null;
    body: StatementNode[];
    redirections: RedirectionNode[];
}
/** C-style for loop: for ((init; cond; step)); do ...; done */
export interface CStyleForNode extends ASTNode {
    type: "CStyleFor";
    init: ArithmeticExpressionNode | null;
    condition: ArithmeticExpressionNode | null;
    update: ArithmeticExpressionNode | null;
    body: StatementNode[];
    redirections: RedirectionNode[];
}
/** while loop */
export interface WhileNode extends ASTNode {
    type: "While";
    condition: StatementNode[];
    body: StatementNode[];
    redirections: RedirectionNode[];
}
/** until loop */
export interface UntilNode extends ASTNode {
    type: "Until";
    condition: StatementNode[];
    body: StatementNode[];
    redirections: RedirectionNode[];
}
/** case statement */
export interface CaseNode extends ASTNode {
    type: "Case";
    word: WordNode;
    items: CaseItemNode[];
    redirections: RedirectionNode[];
}
export interface CaseItemNode extends ASTNode {
    type: "CaseItem";
    patterns: WordNode[];
    body: StatementNode[];
    /** Terminator: ";;" | ";&" | ";;&" */
    terminator: ";;" | ";&" | ";;&";
}
/** Subshell: ( ... ) */
export interface SubshellNode extends ASTNode {
    type: "Subshell";
    body: StatementNode[];
    redirections: RedirectionNode[];
}
/** Command group: { ...; } */
export interface GroupNode extends ASTNode {
    type: "Group";
    body: StatementNode[];
    redirections: RedirectionNode[];
}
/** Arithmetic command: (( expr )) */
export interface ArithmeticCommandNode extends ASTNode {
    type: "ArithmeticCommand";
    expression: ArithmeticExpressionNode;
    redirections: RedirectionNode[];
}
/** Conditional command: [[ expr ]] */
export interface ConditionalCommandNode extends ASTNode {
    type: "ConditionalCommand";
    expression: ConditionalExpressionNode;
    redirections: RedirectionNode[];
    line?: number;
}
/** Function definition */
export interface FunctionDefNode extends ASTNode {
    type: "FunctionDef";
    name: string;
    body: CompoundCommandNode;
    redirections: RedirectionNode[];
    /** Source file where the function was defined (for BASH_SOURCE tracking) */
    sourceFile?: string;
}
/** Variable assignment: VAR=value or VAR+=value */
export interface AssignmentNode extends ASTNode {
    type: "Assignment";
    name: string;
    value: WordNode | null;
    /** Append mode: VAR+=value */
    append: boolean;
    /** Array assignment: VAR=(a b c) */
    array: WordNode[] | null;
}
/** I/O redirection */
export interface RedirectionNode extends ASTNode {
    type: "Redirection";
    /** File descriptor (default depends on operator) */
    fd: number | null;
    /**
     * Variable name for automatic FD allocation ({varname}>file syntax).
     * When set, bash allocates an FD >= 10 and stores the number in this variable.
     */
    fdVariable?: string;
    operator: RedirectionOperator;
    target: WordNode | HereDocNode;
}
export type RedirectionOperator = "<" | ">" | ">>" | ">&" | "<&" | "<>" | ">|" | "&>" | "&>>" | "<<<" | "<<" | "<<-";
/** Here document */
export interface HereDocNode extends ASTNode {
    type: "HereDoc";
    delimiter: string;
    content: WordNode;
    /** Strip leading tabs (<<- vs <<) */
    stripTabs: boolean;
    /** Quoted delimiter means no expansion */
    quoted: boolean;
}
/**
 * A Word is a sequence of parts that form a single shell word.
 * After expansion, it may produce zero, one, or multiple strings.
 */
export interface WordNode extends ASTNode {
    type: "Word";
    parts: WordPart[];
}
/** Parts that can make up a word */
export type WordPart = LiteralPart | SingleQuotedPart | DoubleQuotedPart | EscapedPart | ParameterExpansionPart | CommandSubstitutionPart | ArithmeticExpansionPart | ProcessSubstitutionPart | BraceExpansionPart | TildeExpansionPart | GlobPart;
/** Literal text (no special meaning) */
export interface LiteralPart extends ASTNode {
    type: "Literal";
    value: string;
}
/** Single-quoted string: 'literal' */
export interface SingleQuotedPart extends ASTNode {
    type: "SingleQuoted";
    value: string;
}
/** Double-quoted string: "with $expansion" */
export interface DoubleQuotedPart extends ASTNode {
    type: "DoubleQuoted";
    parts: WordPart[];
}
/** Escaped character: \x */
export interface EscapedPart extends ASTNode {
    type: "Escaped";
    value: string;
}
/** Parameter/variable expansion: $VAR or ${VAR...} */
export interface ParameterExpansionPart extends ASTNode {
    type: "ParameterExpansion";
    parameter: string;
    /** Expansion operation */
    operation: ParameterOperation | null;
}
/** Operations that can be used as inner operations for indirection (${!ref-default}) */
export type InnerParameterOperation = DefaultValueOp | AssignDefaultOp | ErrorIfUnsetOp | UseAlternativeOp | LengthOp | LengthSliceErrorOp | BadSubstitutionOp | SubstringOp | PatternRemovalOp | PatternReplacementOp | CaseModificationOp | TransformOp;
export type ParameterOperation = InnerParameterOperation | IndirectionOp | ArrayKeysOp | VarNamePrefixOp;
/** ${#VAR:...} - invalid syntax, length cannot have substring */
export interface LengthSliceErrorOp {
    type: "LengthSliceError";
}
/** Bad substitution - parsed but errors at runtime (e.g., ${(x)foo} zsh syntax) */
export interface BadSubstitutionOp {
    type: "BadSubstitution";
    /** The raw text that caused the error (for error message) */
    text: string;
}
/** ${VAR:-default} or ${VAR-default} */
export interface DefaultValueOp {
    type: "DefaultValue";
    word: WordNode;
    checkEmpty: boolean;
}
/** ${VAR:=default} or ${VAR=default} */
export interface AssignDefaultOp {
    type: "AssignDefault";
    word: WordNode;
    checkEmpty: boolean;
}
/** ${VAR:?error} or ${VAR?error} */
export interface ErrorIfUnsetOp {
    type: "ErrorIfUnset";
    word: WordNode | null;
    checkEmpty: boolean;
}
/** ${VAR:+alternative} or ${VAR+alternative} */
export interface UseAlternativeOp {
    type: "UseAlternative";
    word: WordNode;
    checkEmpty: boolean;
}
/** ${#VAR} */
export interface LengthOp {
    type: "Length";
}
/** ${VAR:offset} or ${VAR:offset:length} */
export interface SubstringOp {
    type: "Substring";
    offset: ArithmeticExpressionNode;
    length: ArithmeticExpressionNode | null;
}
/** ${VAR#pattern}, ${VAR##pattern}, ${VAR%pattern}, ${VAR%%pattern} */
export interface PatternRemovalOp {
    type: "PatternRemoval";
    pattern: WordNode;
    /** "prefix" = # or ##, "suffix" = % or %% */
    side: "prefix" | "suffix";
    /** Greedy (## or %%) vs non-greedy (# or %) */
    greedy: boolean;
}
/** ${VAR/pattern/replacement} or ${VAR//pattern/replacement} */
export interface PatternReplacementOp {
    type: "PatternReplacement";
    pattern: WordNode;
    replacement: WordNode | null;
    /** Replace all occurrences */
    all: boolean;
    /** Match at start (#) or end (%) only */
    anchor: "start" | "end" | null;
}
/** ${VAR^}, ${VAR^^}, ${VAR,}, ${VAR,,} */
export interface CaseModificationOp {
    type: "CaseModification";
    /** "upper" = ^ or ^^, "lower" = , or ,, */
    direction: "upper" | "lower";
    /** Apply to all characters */
    all: boolean;
    pattern: WordNode | null;
}
/** ${var@Q}, ${var@P}, etc. - parameter transformation */
export interface TransformOp {
    type: "Transform";
    /** Q=quote, P=prompt, a=attributes, A=assignment, E=escape, K=keys, k=keys(alt), u=ucfirst, U=uppercase, L=lowercase */
    operator: "Q" | "P" | "a" | "A" | "E" | "K" | "k" | "u" | "U" | "L";
}
/** ${!VAR} - indirect expansion, optionally combined with another operation like ${!ref-default} */
export interface IndirectionOp {
    type: "Indirection";
    /** Additional operation to apply after indirection (e.g., ${!ref-default}) */
    innerOp?: InnerParameterOperation;
}
/** ${!arr[@]} or ${!arr[*]} - array keys/indices */
export interface ArrayKeysOp {
    type: "ArrayKeys";
    /** The array name (without subscript) */
    array: string;
    /** true if [*] was used instead of [@] */
    star: boolean;
}
/** ${!prefix*} or ${!prefix@} - list variable names with prefix */
export interface VarNamePrefixOp {
    type: "VarNamePrefix";
    /** The prefix to match */
    prefix: string;
    /** true if * was used instead of @ */
    star: boolean;
}
/** Command substitution: $(cmd) or `cmd` */
export interface CommandSubstitutionPart extends ASTNode {
    type: "CommandSubstitution";
    body: ScriptNode;
    /** Legacy backtick syntax */
    legacy: boolean;
}
/** Arithmetic expansion: $((expr)) */
export interface ArithmeticExpansionPart extends ASTNode {
    type: "ArithmeticExpansion";
    expression: ArithmeticExpressionNode;
}
/** Arithmetic expression (for $((...)) and ((...))) */
export interface ArithmeticExpressionNode extends ASTNode {
    type: "ArithmeticExpression";
    expression: ArithExpr;
    /** Original expression text before parsing, used for re-parsing after variable expansion */
    originalText?: string;
}
export type ArithExpr = ArithNumberNode | ArithVariableNode | ArithSpecialVarNode | ArithBinaryNode | ArithUnaryNode | ArithTernaryNode | ArithAssignmentNode | ArithDynamicAssignmentNode | ArithDynamicElementNode | ArithGroupNode | ArithNestedNode | ArithCommandSubstNode | ArithBracedExpansionNode | ArithArrayElementNode | ArithDynamicBaseNode | ArithDynamicNumberNode | ArithConcatNode | ArithDoubleSubscriptNode | ArithNumberSubscriptNode | ArithSyntaxErrorNode | ArithSingleQuoteNode;
export interface ArithBracedExpansionNode extends ASTNode {
    type: "ArithBracedExpansion";
    content: string;
}
/** Dynamic base constant: ${base}#value where base is expanded at runtime */
export interface ArithDynamicBaseNode extends ASTNode {
    type: "ArithDynamicBase";
    baseExpr: string;
    value: string;
}
/** Dynamic number prefix: ${zero}11 or ${zero}xAB for dynamic octal/hex */
export interface ArithDynamicNumberNode extends ASTNode {
    type: "ArithDynamicNumber";
    prefix: string;
    suffix: string;
}
/** Concatenation of multiple parts forming a single numeric value */
export interface ArithConcatNode extends ASTNode {
    type: "ArithConcat";
    parts: ArithExpr[];
}
export interface ArithArrayElementNode extends ASTNode {
    type: "ArithArrayElement";
    array: string;
    /** The index expression (for numeric indices) */
    index?: ArithExpr;
    /** For associative arrays: literal string key (e.g., 'key' or "key") */
    stringKey?: string;
}
/** Invalid double subscript node (e.g., a[1][1]) - evaluated to error at runtime */
export interface ArithDoubleSubscriptNode extends ASTNode {
    type: "ArithDoubleSubscript";
    array: string;
    index: ArithExpr;
}
/** Invalid number subscript node (e.g., 1[2]) - evaluated to error at runtime */
export interface ArithNumberSubscriptNode extends ASTNode {
    type: "ArithNumberSubscript";
    number: string;
    errorToken: string;
}
/** Syntax error in arithmetic expression - evaluated to error at runtime */
export interface ArithSyntaxErrorNode extends ASTNode {
    type: "ArithSyntaxError";
    errorToken: string;
    message: string;
}
/**
 * Single-quoted string in arithmetic expression.
 * In $(()) expansion context, this causes an error.
 * In (()) command context, this is evaluated as a number.
 */
export interface ArithSingleQuoteNode extends ASTNode {
    type: "ArithSingleQuote";
    content: string;
    value: number;
}
export interface ArithNumberNode extends ASTNode {
    type: "ArithNumber";
    value: number;
}
export interface ArithVariableNode extends ASTNode {
    type: "ArithVariable";
    name: string;
    /** True if the variable was written with $ prefix (e.g., $x vs x) */
    hasDollarPrefix?: boolean;
}
/** Special variable node: $*, $@, $#, $?, $-, $!, $$ */
export interface ArithSpecialVarNode extends ASTNode {
    type: "ArithSpecialVar";
    name: string;
}
export interface ArithBinaryNode extends ASTNode {
    type: "ArithBinary";
    operator: "+" | "-" | "*" | "/" | "%" | "**" | "<<" | ">>" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&" | "|" | "^" | "&&" | "||" | ",";
    left: ArithExpr;
    right: ArithExpr;
}
export interface ArithUnaryNode extends ASTNode {
    type: "ArithUnary";
    operator: "-" | "+" | "!" | "~" | "++" | "--";
    operand: ArithExpr;
    /** Prefix vs postfix for ++ and -- */
    prefix: boolean;
}
export interface ArithTernaryNode extends ASTNode {
    type: "ArithTernary";
    condition: ArithExpr;
    consequent: ArithExpr;
    alternate: ArithExpr;
}
export type ArithAssignmentOperator = "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "<<=" | ">>=" | "&=" | "|=" | "^=";
export interface ArithAssignmentNode extends ASTNode {
    type: "ArithAssignment";
    operator: ArithAssignmentOperator;
    variable: string;
    /** For array element assignment: the subscript expression */
    subscript?: ArithExpr;
    /** For associative arrays: literal string key (e.g., 'key' or "key") */
    stringKey?: string;
    value: ArithExpr;
}
/** Dynamic assignment where variable name is built from concatenation: x$foo = 42 or x$foo[5] = 42 */
export interface ArithDynamicAssignmentNode extends ASTNode {
    type: "ArithDynamicAssignment";
    operator: ArithAssignmentOperator;
    /** The target expression (ArithConcat) that evaluates to the variable name */
    target: ArithExpr;
    /** For array element assignment: the subscript expression */
    subscript?: ArithExpr;
    value: ArithExpr;
}
/** Dynamic array element where array name is built from concatenation: x$foo[5] */
export interface ArithDynamicElementNode extends ASTNode {
    type: "ArithDynamicElement";
    /** The expression (ArithConcat) that evaluates to the array name */
    nameExpr: ArithExpr;
    /** The subscript expression */
    subscript: ArithExpr;
}
export interface ArithGroupNode extends ASTNode {
    type: "ArithGroup";
    expression: ArithExpr;
}
/** Nested arithmetic expansion within arithmetic context: $((expr)) */
export interface ArithNestedNode extends ASTNode {
    type: "ArithNested";
    expression: ArithExpr;
}
/** Command substitution within arithmetic context: $(cmd) or `cmd` */
export interface ArithCommandSubstNode extends ASTNode {
    type: "ArithCommandSubst";
    command: string;
}
/** Process substitution: <(cmd) or >(cmd) */
export interface ProcessSubstitutionPart extends ASTNode {
    type: "ProcessSubstitution";
    body: ScriptNode;
    direction: "input" | "output";
}
/** Brace expansion: {a,b,c} or {1..10} */
export interface BraceExpansionPart extends ASTNode {
    type: "BraceExpansion";
    items: BraceItem[];
}
export type BraceItem = {
    type: "Word";
    word: WordNode;
} | {
    type: "Range";
    start: string | number;
    end: string | number;
    step?: number;
    startStr?: string;
    endStr?: string;
};
/** Tilde expansion: ~ or ~user */
export interface TildeExpansionPart extends ASTNode {
    type: "TildeExpansion";
    user: string | null;
}
/** Glob pattern part (expanded during pathname expansion) */
export interface GlobPart extends ASTNode {
    type: "Glob";
    pattern: string;
}
export type ConditionalExpressionNode = CondBinaryNode | CondUnaryNode | CondNotNode | CondAndNode | CondOrNode | CondGroupNode | CondWordNode;
export type CondBinaryOperator = "=" | "==" | "!=" | "=~" | "<" | ">" | "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge" | "-nt" | "-ot" | "-ef";
export interface CondBinaryNode extends ASTNode {
    type: "CondBinary";
    operator: CondBinaryOperator;
    left: WordNode;
    right: WordNode;
}
export type CondUnaryOperator = "-a" | "-b" | "-c" | "-d" | "-e" | "-f" | "-g" | "-h" | "-k" | "-p" | "-r" | "-s" | "-t" | "-u" | "-w" | "-x" | "-G" | "-L" | "-N" | "-O" | "-S" | "-z" | "-n" | "-o" | "-v" | "-R";
export interface CondUnaryNode extends ASTNode {
    type: "CondUnary";
    operator: CondUnaryOperator;
    operand: WordNode;
}
export interface CondNotNode extends ASTNode {
    type: "CondNot";
    operand: ConditionalExpressionNode;
}
export interface CondAndNode extends ASTNode {
    type: "CondAnd";
    left: ConditionalExpressionNode;
    right: ConditionalExpressionNode;
}
export interface CondOrNode extends ASTNode {
    type: "CondOr";
    left: ConditionalExpressionNode;
    right: ConditionalExpressionNode;
}
export interface CondGroupNode extends ASTNode {
    type: "CondGroup";
    expression: ConditionalExpressionNode;
}
export interface CondWordNode extends ASTNode {
    type: "CondWord";
    word: WordNode;
}
export declare const AST: {
    script(statements: StatementNode[]): ScriptNode;
    statement(pipelines: PipelineNode[], operators?: ("&&" | "||" | ";")[], background?: boolean, deferredError?: {
        message: string;
        token: string;
    }, sourceText?: string): StatementNode;
    pipeline(commands: CommandNode[], negated?: boolean, timed?: boolean, timePosix?: boolean, pipeStderr?: boolean[]): PipelineNode;
    simpleCommand(name: WordNode | null, args?: WordNode[], assignments?: AssignmentNode[], redirections?: RedirectionNode[]): SimpleCommandNode;
    word(parts: WordPart[]): WordNode;
    literal(value: string): LiteralPart;
    singleQuoted(value: string): SingleQuotedPart;
    doubleQuoted(parts: WordPart[]): DoubleQuotedPart;
    escaped(value: string): EscapedPart;
    parameterExpansion(parameter: string, operation?: ParameterOperation | null): ParameterExpansionPart;
    commandSubstitution(body: ScriptNode, legacy?: boolean): CommandSubstitutionPart;
    arithmeticExpansion(expression: ArithmeticExpressionNode): ArithmeticExpansionPart;
    assignment(name: string, value: WordNode | null, append?: boolean, array?: WordNode[] | null): AssignmentNode;
    redirection(operator: RedirectionOperator, target: WordNode | HereDocNode, fd?: number | null, fdVariable?: string): RedirectionNode;
    hereDoc(delimiter: string, content: WordNode, stripTabs?: boolean, quoted?: boolean): HereDocNode;
    ifNode(clauses: IfClause[], elseBody?: StatementNode[] | null, redirections?: RedirectionNode[]): IfNode;
    forNode(variable: string, words: WordNode[] | null, body: StatementNode[], redirections?: RedirectionNode[]): ForNode;
    whileNode(condition: StatementNode[], body: StatementNode[], redirections?: RedirectionNode[]): WhileNode;
    untilNode(condition: StatementNode[], body: StatementNode[], redirections?: RedirectionNode[]): UntilNode;
    caseNode(word: WordNode, items: CaseItemNode[], redirections?: RedirectionNode[]): CaseNode;
    caseItem(patterns: WordNode[], body: StatementNode[], terminator?: ";;" | ";&" | ";;&"): CaseItemNode;
    subshell(body: StatementNode[], redirections?: RedirectionNode[]): SubshellNode;
    group(body: StatementNode[], redirections?: RedirectionNode[]): GroupNode;
    functionDef(name: string, body: CompoundCommandNode, redirections?: RedirectionNode[], sourceFile?: string): FunctionDefNode;
    conditionalCommand(expression: ConditionalExpressionNode, redirections?: RedirectionNode[], line?: number): ConditionalCommandNode;
    arithmeticCommand(expression: ArithmeticExpressionNode, redirections?: RedirectionNode[], line?: number): ArithmeticCommandNode;
};
