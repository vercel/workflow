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
declare abstract class ControlFlowError extends Error {
    stdout: string;
    stderr: string;
    constructor(message: string, stdout?: string, stderr?: string);
    /**
     * Prepend output from the current context before re-throwing.
     */
    prependOutput(stdout: string, stderr: string): void;
}
/**
 * Error thrown when break is called to exit loops.
 */
export declare class BreakError extends ControlFlowError {
    levels: number;
    readonly name = "BreakError";
    constructor(levels?: number, stdout?: string, stderr?: string);
}
/**
 * Error thrown when continue is called to skip to next iteration.
 */
export declare class ContinueError extends ControlFlowError {
    levels: number;
    readonly name = "ContinueError";
    constructor(levels?: number, stdout?: string, stderr?: string);
}
/**
 * Error thrown when return is called to exit a function.
 */
export declare class ReturnError extends ControlFlowError {
    exitCode: number;
    readonly name = "ReturnError";
    constructor(exitCode?: number, stdout?: string, stderr?: string);
}
/**
 * Error thrown when set -e (errexit) is enabled and a command fails.
 */
export declare class ErrexitError extends ControlFlowError {
    readonly exitCode: number;
    readonly name = "ErrexitError";
    constructor(exitCode: number, stdout?: string, stderr?: string);
}
/**
 * Error thrown when set -u (nounset) is enabled and an unset variable is referenced.
 */
export declare class NounsetError extends ControlFlowError {
    varName: string;
    readonly name = "NounsetError";
    constructor(varName: string, stdout?: string);
}
/**
 * Error thrown when exit builtin is called to terminate the script.
 */
export declare class ExitError extends ControlFlowError {
    readonly exitCode: number;
    readonly name = "ExitError";
    constructor(exitCode: number, stdout?: string, stderr?: string);
}
/**
 * Error thrown for arithmetic expression errors (e.g., floating point, invalid syntax).
 * Returns exit code 1 instead of 2 (syntax error).
 */
export declare class ArithmeticError extends ControlFlowError {
    readonly name = "ArithmeticError";
    /**
     * If true, this error should abort script execution (like missing operand after binary operator).
     * If false, the error is recoverable and execution can continue.
     */
    fatal: boolean;
    constructor(message: string, stdout?: string, stderr?: string, fatal?: boolean);
}
/**
 * Error thrown for bad substitution errors (e.g., ${#var:1:3}).
 * Returns exit code 1.
 */
export declare class BadSubstitutionError extends ControlFlowError {
    readonly name = "BadSubstitutionError";
    constructor(message: string, stdout?: string, stderr?: string);
}
/**
 * Error thrown when failglob is enabled and a glob pattern has no matches.
 * Returns exit code 1.
 */
export declare class GlobError extends ControlFlowError {
    readonly name = "GlobError";
    constructor(pattern: string, stdout?: string, stderr?: string);
}
/**
 * Error thrown for invalid brace expansions (e.g., mixed case character ranges like {z..A}).
 * Returns exit code 1 (matching bash behavior).
 */
export declare class BraceExpansionError extends ControlFlowError {
    readonly name = "BraceExpansionError";
    constructor(message: string, stdout?: string, stderr?: string);
}
/**
 * Error thrown when execution limits are exceeded (recursion depth, command count, loop iterations).
 * This should ALWAYS be thrown before JavaScript's native RangeError kicks in.
 * Exit code 126 indicates a limit was exceeded.
 */
export declare class ExecutionLimitError extends ControlFlowError {
    readonly limitType: "recursion" | "commands" | "iterations";
    readonly name = "ExecutionLimitError";
    static readonly EXIT_CODE = 126;
    constructor(message: string, limitType: "recursion" | "commands" | "iterations", stdout?: string, stderr?: string);
}
/**
 * Error thrown when break/continue is called in a subshell that was
 * spawned from within a loop context. Causes the subshell to exit cleanly.
 */
export declare class SubshellExitError extends ControlFlowError {
    readonly name = "SubshellExitError";
    constructor(stdout?: string, stderr?: string);
}
/**
 * Type guard for errors that exit the current scope (return, break, continue).
 * These need special handling vs errexit/nounset which terminate execution.
 */
export declare function isScopeExitError(error: unknown): error is BreakError | ContinueError | ReturnError;
/**
 * Error thrown when a POSIX special builtin fails in POSIX mode.
 * In POSIX mode (set -o posix), errors in special builtins like
 * shift, set, readonly, export, etc. cause the entire script to exit.
 *
 * Per POSIX 2.8.1 - Consequences of Shell Errors:
 * "A special built-in utility causes an interactive or non-interactive shell
 * to exit when an error occurs."
 */
export declare class PosixFatalError extends ControlFlowError {
    readonly exitCode: number;
    readonly name = "PosixFatalError";
    constructor(exitCode: number, stdout?: string, stderr?: string);
}
export {};
