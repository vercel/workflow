/**
 * AWK Interpreter
 *
 * Main interpreter class that orchestrates AWK program execution.
 */
import type { AwkProgram } from "../ast.js";
import type { AwkRuntimeContext } from "./context.js";
export declare class AwkInterpreter {
    private ctx;
    private program;
    private rangeStates;
    constructor(ctx: AwkRuntimeContext);
    /**
     * Initialize the interpreter with a program.
     * Must be called before executeBegin/executeLine/executeEnd.
     */
    execute(program: AwkProgram): void;
    /**
     * Execute all BEGIN blocks.
     */
    executeBegin(): Promise<void>;
    /**
     * Execute rules for a single input line.
     */
    executeLine(line: string): Promise<void>;
    /**
     * Execute all END blocks.
     * END blocks run even after exit is called, but exit from within
     * an END block stops further END block execution.
     */
    executeEnd(): Promise<void>;
    /**
     * Get the accumulated output.
     */
    getOutput(): string;
    /**
     * Get the exit code.
     */
    getExitCode(): number;
    /**
     * Get the runtime context (for access to control flow flags, etc.)
     */
    getContext(): AwkRuntimeContext;
    /**
     * Check if a rule matches the current line.
     */
    private matchesRule;
    /**
     * Check if a pattern matches.
     */
    private matchPattern;
}
