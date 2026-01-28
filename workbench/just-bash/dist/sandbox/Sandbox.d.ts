import { Bash } from "../Bash.js";
import type { IFileSystem } from "../fs/interface.js";
import type { NetworkConfig } from "../network/index.js";
import type { CommandFinished } from "./Command.js";
import { Command } from "./Command.js";
export interface SandboxOptions {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    /**
     * Custom filesystem implementation.
     * Mutually exclusive with `overlayRoot`.
     */
    fs?: IFileSystem;
    /**
     * Path to a directory to use as the root of an OverlayFs.
     * Reads come from this directory, writes stay in memory.
     * Mutually exclusive with `fs`.
     */
    overlayRoot?: string;
    maxCallDepth?: number;
    maxCommandCount?: number;
    maxLoopIterations?: number;
    /**
     * Network configuration for commands like curl.
     * Network access is disabled by default - you must explicitly configure allowed URLs.
     */
    network?: NetworkConfig;
}
export interface WriteFilesInput {
    [path: string]: string | {
        content: string;
        encoding?: "utf-8" | "base64";
    };
}
export declare class Sandbox {
    private bashEnv;
    private constructor();
    static create(opts?: SandboxOptions): Promise<Sandbox>;
    runCommand(cmd: string, opts?: {
        cwd?: string;
        env?: Record<string, string>;
    }): Promise<Command>;
    writeFiles(files: WriteFilesInput): Promise<void>;
    readFile(path: string, encoding?: "utf-8" | "base64"): Promise<string>;
    mkDir(path: string, opts?: {
        recursive?: boolean;
    }): Promise<void>;
    stop(): Promise<void>;
    extendTimeout(_ms: number): Promise<void>;
    get domain(): string | undefined;
    /**
     * Bash-specific: Get the underlying Bash instance for advanced operations.
     * Not available in Vercel Sandbox API.
     */
    get bashEnvInstance(): Bash;
}
export { Command };
export type { CommandFinished };
export type { OutputMessage } from "./Command.js";
