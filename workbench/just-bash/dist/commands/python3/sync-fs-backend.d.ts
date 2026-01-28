/**
 * Worker-side synchronous filesystem backend
 *
 * Runs in the worker thread and makes synchronous calls to the main thread
 * via SharedArrayBuffer + Atomics.
 */
/**
 * Synchronous filesystem backend for Pyodide worker.
 */
export declare class SyncFsBackend {
    private protocol;
    constructor(sharedBuffer: SharedArrayBuffer);
    private execSync;
    readFile(path: string): Uint8Array;
    writeFile(path: string, data: Uint8Array): void;
    stat(path: string): {
        isFile: boolean;
        isDirectory: boolean;
        isSymbolicLink: boolean;
        mode: number;
        size: number;
        mtime: Date;
    };
    lstat(path: string): {
        isFile: boolean;
        isDirectory: boolean;
        isSymbolicLink: boolean;
        mode: number;
        size: number;
        mtime: Date;
    };
    readdir(path: string): string[];
    mkdir(path: string, recursive?: boolean): void;
    rm(path: string, recursive?: boolean, force?: boolean): void;
    exists(path: string): boolean;
    appendFile(path: string, data: Uint8Array): void;
    symlink(target: string, linkPath: string): void;
    readlink(path: string): string;
    chmod(path: string, mode: number): void;
    realpath(path: string): string;
    writeStdout(data: string): void;
    writeStderr(data: string): void;
    exit(code: number): void;
    /**
     * Make an HTTP request through the main thread's secureFetch.
     * Returns the response as a parsed object.
     */
    httpRequest(url: string, options?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
    }): {
        status: number;
        statusText: string;
        headers: Record<string, string>;
        body: string;
        url: string;
    };
}
