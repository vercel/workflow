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
// =============================================================================
// FACTORY FUNCTIONS (for building AST nodes)
// =============================================================================
export const AST = {
    script(statements) {
        return { type: "Script", statements };
    },
    statement(pipelines, operators = [], background = false, deferredError, sourceText) {
        const node = {
            type: "Statement",
            pipelines,
            operators,
            background,
        };
        if (deferredError) {
            node.deferredError = deferredError;
        }
        if (sourceText !== undefined) {
            node.sourceText = sourceText;
        }
        return node;
    },
    pipeline(commands, negated = false, timed = false, timePosix = false, pipeStderr) {
        return {
            type: "Pipeline",
            commands,
            negated,
            timed,
            timePosix,
            pipeStderr,
        };
    },
    simpleCommand(name, args = [], assignments = [], redirections = []) {
        return { type: "SimpleCommand", name, args, assignments, redirections };
    },
    word(parts) {
        return { type: "Word", parts };
    },
    literal(value) {
        return { type: "Literal", value };
    },
    singleQuoted(value) {
        return { type: "SingleQuoted", value };
    },
    doubleQuoted(parts) {
        return { type: "DoubleQuoted", parts };
    },
    escaped(value) {
        return { type: "Escaped", value };
    },
    parameterExpansion(parameter, operation = null) {
        return { type: "ParameterExpansion", parameter, operation };
    },
    commandSubstitution(body, legacy = false) {
        return { type: "CommandSubstitution", body, legacy };
    },
    arithmeticExpansion(expression) {
        return { type: "ArithmeticExpansion", expression };
    },
    assignment(name, value, append = false, array = null) {
        return { type: "Assignment", name, value, append, array };
    },
    redirection(operator, target, fd = null, fdVariable) {
        const node = { type: "Redirection", fd, operator, target };
        if (fdVariable) {
            node.fdVariable = fdVariable;
        }
        return node;
    },
    hereDoc(delimiter, content, stripTabs = false, quoted = false) {
        return { type: "HereDoc", delimiter, content, stripTabs, quoted };
    },
    ifNode(clauses, elseBody = null, redirections = []) {
        return { type: "If", clauses, elseBody, redirections };
    },
    forNode(variable, words, body, redirections = []) {
        return { type: "For", variable, words, body, redirections };
    },
    whileNode(condition, body, redirections = []) {
        return { type: "While", condition, body, redirections };
    },
    untilNode(condition, body, redirections = []) {
        return { type: "Until", condition, body, redirections };
    },
    caseNode(word, items, redirections = []) {
        return { type: "Case", word, items, redirections };
    },
    caseItem(patterns, body, terminator = ";;") {
        return { type: "CaseItem", patterns, body, terminator };
    },
    subshell(body, redirections = []) {
        return { type: "Subshell", body, redirections };
    },
    group(body, redirections = []) {
        return { type: "Group", body, redirections };
    },
    functionDef(name, body, redirections = [], sourceFile) {
        return { type: "FunctionDef", name, body, redirections, sourceFile };
    },
    conditionalCommand(expression, redirections = [], line) {
        return { type: "ConditionalCommand", expression, redirections, line };
    },
    arithmeticCommand(expression, redirections = [], line) {
        return { type: "ArithmeticCommand", expression, redirections, line };
    },
};
