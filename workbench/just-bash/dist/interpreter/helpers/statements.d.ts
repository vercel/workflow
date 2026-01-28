/**
 * Statement execution helpers for the interpreter.
 *
 * Consolidates the common pattern of executing a list of statements
 * and accumulating their output.
 */
import type { StatementNode } from "../../ast/types.js";
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
/**
 * Execute a list of statements and accumulate their output.
 * Handles scope exit errors (break, continue, return) and errexit properly.
 *
 * @param ctx - Interpreter context
 * @param statements - Statements to execute
 * @param initialStdout - Initial stdout to prepend (default "")
 * @param initialStderr - Initial stderr to prepend (default "")
 * @returns Accumulated stdout, stderr, and final exit code
 */
export declare function executeStatements(ctx: InterpreterContext, statements: StatementNode[], initialStdout?: string, initialStderr?: string): Promise<ExecResult>;
