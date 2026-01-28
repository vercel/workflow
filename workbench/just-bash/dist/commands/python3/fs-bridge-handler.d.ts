/**
 * Main thread filesystem bridge handler
 *
 * Runs on the main thread and processes filesystem requests from the worker thread.
 * Uses SharedArrayBuffer + Atomics for synchronization.
 */
import type { IFileSystem } from "../../fs/interface.js";
import type { SecureFetch } from "../../network/fetch.js";
export interface FsBridgeOutput {
    stdout: string;
    stderr: string;
    exitCode: number;
}
/**
 * Handles filesystem requests from the worker thread.
 */
export declare class FsBridgeHandler {
    private fs;
    private cwd;
    private secureFetch;
    private protocol;
    private running;
    private output;
    constructor(sharedBuffer: SharedArrayBuffer, fs: IFileSystem, cwd: string, secureFetch?: SecureFetch | undefined);
    /**
     * Run the handler loop until EXIT operation or timeout.
     */
    run(timeoutMs: number): Promise<FsBridgeOutput>;
    stop(): void;
    private handleOperation;
    private resolvePath;
    private handleReadFile;
    private handleWriteFile;
    private handleStat;
    private handleLstat;
    private handleReaddir;
    private handleMkdir;
    private handleRm;
    private handleExists;
    private handleAppendFile;
    private handleSymlink;
    private handleReadlink;
    private handleChmod;
    private handleRealpath;
    private handleWriteStdout;
    private handleWriteStderr;
    private handleExit;
    private handleHttpRequest;
    private setErrorFromException;
}
