/**
 * sqlite3 - SQLite database CLI
 *
 * Wraps sql.js (WASM) to provide SQLite database access through the virtual filesystem.
 * Databases are loaded from buffers and written back after modifications.
 *
 * Queries run in a worker thread with a timeout to prevent runaway queries
 * (e.g., infinite recursive CTEs) from blocking execution.
 *
 * Security: sql.js is fully sandboxed - it cannot access the real filesystem,
 * making ATTACH DATABASE and VACUUM INTO safe (they only operate on virtual buffers).
 */
import type { Command } from "../../types.js";
export declare const sqlite3Command: Command;
