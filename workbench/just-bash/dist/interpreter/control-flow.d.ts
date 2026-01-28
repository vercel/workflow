/**
 * Control Flow Execution
 *
 * Handles control flow constructs:
 * - if/elif/else
 * - for loops
 * - C-style for loops
 * - while loops
 * - until loops
 * - case statements
 * - break/continue
 */
import type { CaseNode, CStyleForNode, ForNode, IfNode, UntilNode, WhileNode } from "../ast/types.js";
import type { ExecResult } from "../types.js";
import type { InterpreterContext } from "./types.js";
export declare function executeIf(ctx: InterpreterContext, node: IfNode): Promise<ExecResult>;
export declare function executeFor(ctx: InterpreterContext, node: ForNode): Promise<ExecResult>;
export declare function executeCStyleFor(ctx: InterpreterContext, node: CStyleForNode): Promise<ExecResult>;
export declare function executeWhile(ctx: InterpreterContext, node: WhileNode, stdin?: string): Promise<ExecResult>;
export declare function executeUntil(ctx: InterpreterContext, node: UntilNode): Promise<ExecResult>;
export declare function executeCase(ctx: InterpreterContext, node: CaseNode): Promise<ExecResult>;
