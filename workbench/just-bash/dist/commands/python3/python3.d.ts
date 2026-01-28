/**
 * python3 - Execute Python code via Pyodide (Python in WebAssembly)
 *
 * Runs Python code in an isolated worker thread with access to the
 * virtual filesystem via SharedArrayBuffer bridge.
 *
 * This command is Node.js only (uses worker_threads).
 */
import type { Command } from "../../types.js";
export declare const python3Command: Command;
export declare const pythonCommand: Command;
