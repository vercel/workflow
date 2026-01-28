/**
 * ExecResult factory functions for cleaner code.
 *
 * These helpers reduce verbosity and improve readability when
 * constructing ExecResult objects throughout the interpreter.
 */
import type { ExecResult } from "../../types.js";
/**
 * A successful result with no output.
 * Use this for commands that succeed silently.
 */
export declare const OK: ExecResult;
/**
 * Create a successful result with optional stdout.
 *
 * @param stdout - Output to include (default: "")
 * @returns ExecResult with exitCode 0
 */
export declare function success(stdout?: string): ExecResult;
/**
 * Create a failure result with stderr message.
 *
 * @param stderr - Error message to include
 * @param exitCode - Exit code (default: 1)
 * @returns ExecResult with the specified exitCode
 */
export declare function failure(stderr: string, exitCode?: number): ExecResult;
/**
 * Create a result with all fields specified.
 *
 * @param stdout - Standard output
 * @param stderr - Standard error
 * @param exitCode - Exit code
 * @returns ExecResult with all fields
 */
export declare function result(stdout: string, stderr: string, exitCode: number): ExecResult;
/**
 * Convert a boolean test result to an ExecResult.
 * Useful for test/conditional commands where true = exit 0, false = exit 1.
 *
 * @param passed - Boolean test result
 * @returns ExecResult with exitCode 0 if passed, 1 otherwise
 */
export declare function testResult(passed: boolean): ExecResult;
/**
 * Throw an ExecutionLimitError for execution limits (recursion, iterations, commands).
 *
 * @param message - Error message describing the limit exceeded
 * @param limitType - Type of limit exceeded
 * @param stdout - Accumulated stdout to include
 * @param stderr - Accumulated stderr to include
 * @throws ExecutionLimitError always
 */
export declare function throwExecutionLimit(message: string, limitType: "recursion" | "iterations" | "commands", stdout?: string, stderr?: string): never;
