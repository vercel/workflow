/**
 * SharedArrayBuffer protocol for synchronous filesystem bridge
 *
 * This protocol enables synchronous filesystem access from a worker thread
 * (where Pyodide/Python runs) to the main thread (which has async IFileSystem).
 */
declare global {
    interface Atomics {
        waitAsync(typedArray: Int32Array, index: number, value: number, timeout?: number): {
            async: false;
            value: "not-equal" | "timed-out";
        } | {
            async: true;
            value: Promise<"ok" | "timed-out">;
        };
    }
}
/** Operation codes */
export declare const OpCode: {
    readonly NOOP: 0;
    readonly READ_FILE: 1;
    readonly WRITE_FILE: 2;
    readonly STAT: 3;
    readonly READDIR: 4;
    readonly MKDIR: 5;
    readonly RM: 6;
    readonly EXISTS: 7;
    readonly APPEND_FILE: 8;
    readonly SYMLINK: 9;
    readonly READLINK: 10;
    readonly LSTAT: 11;
    readonly CHMOD: 12;
    readonly REALPATH: 13;
    readonly WRITE_STDOUT: 100;
    readonly WRITE_STDERR: 101;
    readonly EXIT: 102;
    readonly HTTP_REQUEST: 200;
};
export type OpCodeType = (typeof OpCode)[keyof typeof OpCode];
/** Status codes for synchronization */
export declare const Status: {
    readonly PENDING: 0;
    readonly READY: 1;
    readonly SUCCESS: 2;
    readonly ERROR: 3;
};
export type StatusType = (typeof Status)[keyof typeof Status];
/** Error codes */
export declare const ErrorCode: {
    readonly NONE: 0;
    readonly NOT_FOUND: 1;
    readonly IS_DIRECTORY: 2;
    readonly NOT_DIRECTORY: 3;
    readonly EXISTS: 4;
    readonly PERMISSION_DENIED: 5;
    readonly INVALID_PATH: 6;
    readonly IO_ERROR: 7;
    readonly TIMEOUT: 8;
    readonly NETWORK_ERROR: 9;
    readonly NETWORK_NOT_CONFIGURED: 10;
};
export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];
/** Flags for operations */
export declare const Flags: {
    readonly NONE: 0;
    readonly RECURSIVE: 1;
    readonly FORCE: 2;
    readonly MKDIR_RECURSIVE: 1;
};
/** Create a new SharedArrayBuffer for the protocol */
export declare function createSharedBuffer(): SharedArrayBuffer;
/**
 * Helper class for reading/writing protocol data
 */
export declare class ProtocolBuffer {
    private int32View;
    private uint8View;
    private dataView;
    constructor(buffer: SharedArrayBuffer);
    getOpCode(): OpCodeType;
    setOpCode(code: OpCodeType): void;
    getStatus(): StatusType;
    setStatus(status: StatusType): void;
    getPathLength(): number;
    setPathLength(length: number): void;
    getDataLength(): number;
    setDataLength(length: number): void;
    getResultLength(): number;
    setResultLength(length: number): void;
    getErrorCode(): ErrorCodeType;
    setErrorCode(code: ErrorCodeType): void;
    getFlags(): number;
    setFlags(flags: number): void;
    getMode(): number;
    setMode(mode: number): void;
    getPath(): string;
    setPath(path: string): void;
    getData(): Uint8Array;
    setData(data: Uint8Array): void;
    getDataAsString(): string;
    setDataFromString(str: string): void;
    getResult(): Uint8Array;
    setResult(data: Uint8Array): void;
    getResultAsString(): string;
    setResultFromString(str: string): void;
    encodeStat(stat: {
        isFile: boolean;
        isDirectory: boolean;
        isSymbolicLink: boolean;
        mode: number;
        size: number;
        mtime: Date;
    }): void;
    decodeStat(): {
        isFile: boolean;
        isDirectory: boolean;
        isSymbolicLink: boolean;
        mode: number;
        size: number;
        mtime: Date;
    };
    waitForReady(timeout?: number): "ok" | "timed-out" | "not-equal";
    waitForReadyAsync(timeout?: number): {
        async: false;
        value: "not-equal" | "timed-out";
    } | {
        async: true;
        value: Promise<"ok" | "timed-out">;
    };
    /**
     * Wait for status to become READY.
     * Returns immediately if status is already READY, or waits until it changes.
     */
    waitUntilReady(timeout: number): Promise<boolean>;
    waitForResult(timeout?: number): "ok" | "timed-out" | "not-equal";
    notify(): number;
    reset(): void;
}
