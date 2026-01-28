/**
 * Bash - Bash Shell Environment
 *
 * A complete bash-like shell environment using a proper AST-based architecture:
 *   Input → Parser → AST → Interpreter → Output
 *
 * This class provides the shell environment (filesystem, commands, variables)
 * and delegates execution to the Interpreter.
 */
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { type CommandName } from "./commands/registry.js";
import { type CustomCommand } from "./custom-commands.js";
import type { IFileSystem, InitialFiles } from "./fs/interface.js";
import { type InterpreterState } from "./interpreter/index.js";
import { type ExecutionLimits } from "./limits.js";
import { type NetworkConfig } from "./network/index.js";
import type { BashExecResult, Command, TraceCallback } from "./types.js";
export type { ExecutionLimits } from "./limits.js";
/**
 * Logger interface for Bash execution logging.
 * Implement this interface to receive execution logs.
 */
export interface BashLogger {
    /** Log informational messages (exec commands, stderr, exit codes) */
    info(message: string, data?: Record<string, unknown>): void;
    /** Log debug messages (stdout output) */
    debug(message: string, data?: Record<string, unknown>): void;
}
export interface BashOptions {
    files?: InitialFiles;
    env?: Record<string, string>;
    cwd?: string;
    fs?: IFileSystem;
    /**
     * Execution limits to prevent runaway compute.
     * See ExecutionLimits interface for available options.
     */
    executionLimits?: ExecutionLimits;
    /**
     * @deprecated Use executionLimits.maxCallDepth instead
     */
    maxCallDepth?: number;
    /**
     * @deprecated Use executionLimits.maxCommandCount instead
     */
    maxCommandCount?: number;
    /**
     * @deprecated Use executionLimits.maxLoopIterations instead
     */
    maxLoopIterations?: number;
    /**
     * Network configuration for commands like curl.
     * Network access is disabled by default - you must explicitly configure allowed URLs.
     */
    network?: NetworkConfig;
    /**
     * Optional list of command names to register.
     * If not provided, all built-in commands are available.
     * Use this to restrict which commands can be executed.
     */
    commands?: CommandName[];
    /**
     * Optional sleep function for the sleep command.
     * If provided, used instead of real setTimeout.
     * Useful for testing with mock clocks.
     */
    sleep?: (ms: number) => Promise<void>;
    /**
     * Custom commands to register alongside built-in commands.
     * These take precedence over built-ins with the same name.
     *
     * @example
     * ```ts
     * import { defineCommand } from "just-bash";
     *
     * const hello = defineCommand("hello", async (args) => ({
     *   stdout: `Hello, ${args[0] || "world"}!\n`,
     *   stderr: "",
     *   exitCode: 0,
     * }));
     *
     * const bash = new Bash({ customCommands: [hello] });
     * ```
     */
    customCommands?: CustomCommand[];
    /**
     * Optional logger for execution tracing.
     * When provided, logs exec commands (info), stdout (debug), stderr (info), and exit codes (info).
     * Disabled by default.
     */
    logger?: BashLogger;
    /**
     * Optional trace callback for performance profiling.
     * When provided, commands emit timing events for analysis.
     * Useful for identifying performance bottlenecks.
     */
    trace?: TraceCallback;
}
export interface ExecOptions {
    /**
     * Environment variables to set for this execution only.
     * These are merged with the current environment and restored after execution.
     */
    env?: Record<string, string>;
    /**
     * Working directory for this execution only.
     * Restored to original after execution.
     */
    cwd?: string;
    /**
     * If true, skip normalizing the script (trimming leading whitespace from lines).
     * Useful when running scripts where leading whitespace is significant (e.g., here-docs).
     * Default: false
     */
    rawScript?: boolean;
}
export declare class Bash {
    readonly fs: IFileSystem;
    private commands;
    private useDefaultLayout;
    private limits;
    private secureFetch?;
    private sleepFn?;
    private traceFn?;
    private logger?;
    private state;
    constructor(options?: BashOptions);
    /**
     * Serialize Bash instance for Workflow DevKit.
     * Serializes filesystem and interpreter state. Callbacks (logger, trace, sleep,
     * secureFetch) and custom commands are NOT serialized - re-register after deserialize.
     */
    static [WORKFLOW_SERIALIZE](instance: Bash): {
        fs: IFileSystem;
        state: InterpreterState;
        limits: Required<ExecutionLimits>;
    };
    /**
     * Deserialize Bash instance for Workflow DevKit.
     * Note: Only works with InMemoryFs. Callbacks must be re-configured after deserialize.
     */
    static [WORKFLOW_DESERIALIZE](serialized: {
        fs: IFileSystem;
        state: InterpreterState;
        limits: Required<ExecutionLimits>;
    }): Bash;
    registerCommand(command: Command): void;
    private logResult;
    exec(commandLine: string, options?: ExecOptions): Promise<BashExecResult>;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    getCwd(): string;
    getEnv(): Record<string, string>;
}
