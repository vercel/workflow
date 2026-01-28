/**
 * Pipeline Execution
 *
 * Handles execution of command pipelines (cmd1 | cmd2 | cmd3).
 */
import type { CommandNode, PipelineNode } from "../ast/types.js";
import type { ExecResult } from "../types.js";
import type { InterpreterContext } from "./types.js";
/**
 * Type for executeCommand callback
 */
export type ExecuteCommandFn = (node: CommandNode, stdin: string) => Promise<ExecResult>;
/**
 * Execute a pipeline node (command or sequence of piped commands).
 */
export declare function executePipeline(ctx: InterpreterContext, node: PipelineNode, executeCommand: ExecuteCommandFn): Promise<ExecResult>;
