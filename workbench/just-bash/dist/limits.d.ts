/**
 * Execution Limits Configuration
 *
 * Centralized configuration for all execution limits to prevent runaway compute.
 * These limits can be overridden when creating a BashEnv instance.
 */
/**
 * Configuration for execution limits.
 * All limits are optional - undefined values use defaults.
 */
export interface ExecutionLimits {
    /** Maximum function call/recursion depth (default: 100) */
    maxCallDepth?: number;
    /** Maximum number of commands to execute (default: 10000) */
    maxCommandCount?: number;
    /** Maximum loop iterations for bash while/for/until loops (default: 10000) */
    maxLoopIterations?: number;
    /** Maximum loop iterations for AWK while/for loops (default: 10000) */
    maxAwkIterations?: number;
    /** Maximum command iterations for SED (branch loops) (default: 10000) */
    maxSedIterations?: number;
    /** Maximum iterations for jq loops (until, while, repeat) (default: 10000) */
    maxJqIterations?: number;
    /** Maximum sqlite3 query execution time in milliseconds (default: 5000) */
    maxSqliteTimeoutMs?: number;
    /** Maximum Python execution time in milliseconds (default: 30000) */
    maxPythonTimeoutMs?: number;
}
/**
 * Resolve execution limits by merging user-provided limits with defaults.
 */
export declare function resolveLimits(userLimits?: ExecutionLimits): Required<ExecutionLimits>;
