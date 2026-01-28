/**
 * Control Flow Errors
 *
 * Error classes used to implement shell control flow:
 * - break: Exit loops
 * - continue: Skip to next iteration
 * - return: Exit functions
 * - errexit: Exit on error (set -e)
 * - nounset: Error on unset variables (set -u)
 *
 * All control flow errors carry stdout/stderr to accumulate output
 * as they propagate through the execution stack.
 */
/**
 * Base class for all control flow errors.
 * Carries stdout/stderr to preserve output during propagation.
 */
class ControlFlowError extends Error {
    stdout;
    stderr;
    constructor(message, stdout = "", stderr = "") {
        super(message);
        this.stdout = stdout;
        this.stderr = stderr;
    }
    /**
     * Prepend output from the current context before re-throwing.
     */
    prependOutput(stdout, stderr) {
        this.stdout = stdout + this.stdout;
        this.stderr = stderr + this.stderr;
    }
}
/**
 * Error thrown when break is called to exit loops.
 */
export class BreakError extends ControlFlowError {
    levels;
    name = "BreakError";
    constructor(levels = 1, stdout = "", stderr = "") {
        super("break", stdout, stderr);
        this.levels = levels;
    }
}
/**
 * Error thrown when continue is called to skip to next iteration.
 */
export class ContinueError extends ControlFlowError {
    levels;
    name = "ContinueError";
    constructor(levels = 1, stdout = "", stderr = "") {
        super("continue", stdout, stderr);
        this.levels = levels;
    }
}
/**
 * Error thrown when return is called to exit a function.
 */
export class ReturnError extends ControlFlowError {
    exitCode;
    name = "ReturnError";
    constructor(exitCode = 0, stdout = "", stderr = "") {
        super("return", stdout, stderr);
        this.exitCode = exitCode;
    }
}
/**
 * Error thrown when set -e (errexit) is enabled and a command fails.
 */
export class ErrexitError extends ControlFlowError {
    exitCode;
    name = "ErrexitError";
    constructor(exitCode, stdout = "", stderr = "") {
        super(`errexit: command exited with status ${exitCode}`, stdout, stderr);
        this.exitCode = exitCode;
    }
}
/**
 * Error thrown when set -u (nounset) is enabled and an unset variable is referenced.
 */
export class NounsetError extends ControlFlowError {
    varName;
    name = "NounsetError";
    constructor(varName, stdout = "") {
        super(`${varName}: unbound variable`, stdout, `bash: ${varName}: unbound variable\n`);
        this.varName = varName;
    }
}
/**
 * Error thrown when exit builtin is called to terminate the script.
 */
export class ExitError extends ControlFlowError {
    exitCode;
    name = "ExitError";
    constructor(exitCode, stdout = "", stderr = "") {
        super(`exit`, stdout, stderr);
        this.exitCode = exitCode;
    }
}
/**
 * Error thrown for arithmetic expression errors (e.g., floating point, invalid syntax).
 * Returns exit code 1 instead of 2 (syntax error).
 */
export class ArithmeticError extends ControlFlowError {
    name = "ArithmeticError";
    /**
     * If true, this error should abort script execution (like missing operand after binary operator).
     * If false, the error is recoverable and execution can continue.
     */
    fatal;
    constructor(message, stdout = "", stderr = "", fatal = false) {
        super(message, stdout, stderr);
        this.stderr = stderr || `bash: ${message}\n`;
        this.fatal = fatal;
    }
}
/**
 * Error thrown for bad substitution errors (e.g., ${#var:1:3}).
 * Returns exit code 1.
 */
export class BadSubstitutionError extends ControlFlowError {
    name = "BadSubstitutionError";
    constructor(message, stdout = "", stderr = "") {
        super(message, stdout, stderr);
        this.stderr = stderr || `bash: ${message}: bad substitution\n`;
    }
}
/**
 * Error thrown when failglob is enabled and a glob pattern has no matches.
 * Returns exit code 1.
 */
export class GlobError extends ControlFlowError {
    name = "GlobError";
    constructor(pattern, stdout = "", stderr = "") {
        super(`no match: ${pattern}`, stdout, stderr);
        this.stderr = stderr || `bash: no match: ${pattern}\n`;
    }
}
/**
 * Error thrown for invalid brace expansions (e.g., mixed case character ranges like {z..A}).
 * Returns exit code 1 (matching bash behavior).
 */
export class BraceExpansionError extends ControlFlowError {
    name = "BraceExpansionError";
    constructor(message, stdout = "", stderr = "") {
        super(message, stdout, stderr);
        this.stderr = stderr || `bash: ${message}\n`;
    }
}
/**
 * Error thrown when execution limits are exceeded (recursion depth, command count, loop iterations).
 * This should ALWAYS be thrown before JavaScript's native RangeError kicks in.
 * Exit code 126 indicates a limit was exceeded.
 */
export class ExecutionLimitError extends ControlFlowError {
    limitType;
    name = "ExecutionLimitError";
    static EXIT_CODE = 126;
    constructor(message, limitType, stdout = "", stderr = "") {
        super(message, stdout, stderr);
        this.limitType = limitType;
        this.stderr = stderr || `bash: ${message}\n`;
    }
}
/**
 * Error thrown when break/continue is called in a subshell that was
 * spawned from within a loop context. Causes the subshell to exit cleanly.
 */
export class SubshellExitError extends ControlFlowError {
    name = "SubshellExitError";
    constructor(stdout = "", stderr = "") {
        super("subshell exit", stdout, stderr);
    }
}
/**
 * Type guard for errors that exit the current scope (return, break, continue).
 * These need special handling vs errexit/nounset which terminate execution.
 */
export function isScopeExitError(error) {
    return (error instanceof BreakError ||
        error instanceof ContinueError ||
        error instanceof ReturnError);
}
/**
 * Error thrown when a POSIX special builtin fails in POSIX mode.
 * In POSIX mode (set -o posix), errors in special builtins like
 * shift, set, readonly, export, etc. cause the entire script to exit.
 *
 * Per POSIX 2.8.1 - Consequences of Shell Errors:
 * "A special built-in utility causes an interactive or non-interactive shell
 * to exit when an error occurs."
 */
export class PosixFatalError extends ControlFlowError {
    exitCode;
    name = "PosixFatalError";
    constructor(exitCode, stdout = "", stderr = "") {
        super("posix fatal error", stdout, stderr);
        this.exitCode = exitCode;
    }
}
