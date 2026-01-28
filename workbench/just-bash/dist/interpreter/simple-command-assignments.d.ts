/**
 * Simple Command Assignment Handling
 *
 * Handles variable assignments in simple commands:
 * - Array assignments: VAR=(a b c)
 * - Subscript assignments: VAR[idx]=value
 * - Scalar assignments with nameref resolution
 */
import type { SimpleCommandNode } from "../ast/types.js";
import type { ExecResult } from "../types.js";
import type { InterpreterContext } from "./types.js";
/**
 * Result of processing assignments in a simple command
 */
export interface AssignmentResult {
    /** Whether to continue to the next statement (skip command execution) */
    continueToNext: boolean;
    /** Accumulated xtrace output for assignments */
    xtraceOutput: string;
    /** Temporary assignments for prefix bindings (FOO=bar cmd) */
    tempAssignments: Record<string, string | undefined>;
    /** Error result if assignment failed */
    error?: ExecResult;
}
/**
 * Process all assignments in a simple command.
 * Returns assignment results including temp bindings and any errors.
 */
export declare function processAssignments(ctx: InterpreterContext, node: SimpleCommandNode): Promise<AssignmentResult>;
