/**
 * Lightweight Bash class for Workflow context.
 *
 * This is a minimal version of the Bash class that only handles state storage
 * and serialization. It does NOT include command execution capabilities.
 *
 * In workflow context, Bash instances are only passed between steps - actual
 * command execution happens in step context where the full Bash class is used.
 *
 * IMPORTANT: This class must have the same serialization format as the full
 * Bash class so that instances can be serialized in step context and
 * deserialized in workflow context (and vice versa).
 */
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import type { IFileSystem } from "./fs/interface.js";
import type { ExecutionLimits } from "./limits.js";
/**
 * Interpreter state interface - must match the full Bash class.
 * This is a simplified type definition for the workflow context.
 */
interface InterpreterState {
    env: Record<string, string>;
    cwd: string;
    previousDir: string;
    lastExitCode: number;
    lastArg: string;
    currentLine: number;
    options: Record<string, boolean>;
    shoptOptions: Record<string, boolean>;
    functions: Map<string, unknown>;
    localScopes: unknown[];
    callDepth: number;
    sourceDepth: number;
    commandCount: number;
    startTime: number;
    lastBackgroundPid: number;
    bashPid: number;
    nextVirtualPid: number;
    exportedVars: Set<string>;
    readonlyVars: Set<string>;
    hashTable?: Map<string, string>;
    inCondition: boolean;
    loopDepth: number;
}
/**
 * Minimal Bash options for workflow context.
 * Only the options needed for deserialization.
 */
export interface BashWorkflowOptions {
    fs?: IFileSystem;
    executionLimits?: ExecutionLimits;
}
/**
 * Lightweight Bash class for workflow context.
 *
 * This class can:
 * - Be serialized and deserialized
 * - Hold filesystem and interpreter state
 * - Be passed between workflow steps
 *
 * This class CANNOT:
 * - Execute bash commands (use the full Bash class in step context)
 * - Access command implementations
 */
export declare class Bash {
    readonly fs: IFileSystem;
    private state;
    private limits;
    constructor(options?: BashWorkflowOptions);
    /**
     * Serialize Bash instance for Workflow DevKit.
     * Serializes filesystem and interpreter state.
     */
    static [WORKFLOW_SERIALIZE](instance: Bash): {
        fs: IFileSystem;
        state: InterpreterState;
        limits: Required<ExecutionLimits>;
    };
    /**
     * Deserialize Bash instance for Workflow DevKit.
     */
    static [WORKFLOW_DESERIALIZE](serialized: {
        fs: IFileSystem;
        state: InterpreterState;
        limits: Required<ExecutionLimits>;
    }): Bash;
    getCwd(): string;
    getEnv(): Record<string, string>;
}
export {};
