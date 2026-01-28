/**
 * Worker thread for Python execution via Pyodide.
 * Keeps Pyodide loaded and handles multiple execution requests.
 */
export interface WorkerInput {
    sharedBuffer: SharedArrayBuffer;
    pythonCode: string;
    cwd: string;
    env: Record<string, string>;
    args: string[];
    scriptPath?: string;
}
export interface WorkerOutput {
    success: boolean;
    error?: string;
}
