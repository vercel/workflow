/**
 * Worker thread for sqlite3 query execution.
 *
 * This isolates potentially long-running queries so they can be
 * terminated if they exceed the timeout.
 *
 * Uses sql.js (WASM-based SQLite) which is fully sandboxed and cannot
 * access the real filesystem.
 */
export interface WorkerInput {
    dbBuffer: Uint8Array | null;
    sql: string;
    options: {
        bail: boolean;
        echo: boolean;
    };
}
export interface WorkerSuccess {
    success: true;
    results: StatementResult[];
    hasModifications: boolean;
    dbBuffer: Uint8Array | null;
}
export interface StatementResult {
    type: "data" | "error";
    columns?: string[];
    rows?: unknown[][];
    error?: string;
}
export interface WorkerError {
    success: false;
    error: string;
}
export type WorkerOutput = WorkerSuccess | WorkerError;
