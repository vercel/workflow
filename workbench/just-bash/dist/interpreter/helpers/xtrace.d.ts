/**
 * xtrace (set -x) helper functions
 *
 * Handles trace output generation when xtrace option is enabled.
 * PS4 variable controls the prefix (default "+ ").
 * PS4 is expanded (variable substitution) before each trace line.
 */
import type { InterpreterContext } from "../types.js";
/**
 * Generate xtrace output for a simple command.
 * Returns the trace line to be added to stderr.
 */
export declare function traceSimpleCommand(ctx: InterpreterContext, commandName: string, args: string[]): Promise<string>;
/**
 * Generate xtrace output for an assignment.
 * Returns the trace line to be added to stderr.
 */
export declare function traceAssignment(ctx: InterpreterContext, name: string, value: string): Promise<string>;
