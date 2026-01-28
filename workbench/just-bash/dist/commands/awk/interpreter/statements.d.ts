/**
 * AWK Statement Execution
 *
 * Async statement executor supporting file I/O operations.
 */
import type { AwkStmt } from "../ast.js";
import type { AwkRuntimeContext } from "./context.js";
/**
 * Execute a block of statements.
 */
export declare function executeBlock(ctx: AwkRuntimeContext, statements: AwkStmt[]): Promise<void>;
