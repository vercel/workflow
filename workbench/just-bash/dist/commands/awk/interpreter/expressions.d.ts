/**
 * AWK Expression Evaluation
 *
 * Async expression evaluator supporting file I/O operations.
 */
import type { AwkExpr } from "../ast.js";
import type { AwkRuntimeContext } from "./context.js";
import type { AwkValue } from "./types.js";
export type BlockExecutor = (ctx: AwkRuntimeContext, statements: import("../ast.js").AwkStmt[]) => Promise<void>;
/**
 * Set the block executor function (called from statements.ts to avoid circular deps)
 */
export declare function setBlockExecutor(fn: BlockExecutor): void;
/**
 * Evaluate an AWK expression asynchronously.
 */
export declare function evalExpr(ctx: AwkRuntimeContext, expr: AwkExpr): Promise<AwkValue>;
