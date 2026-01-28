/**
 * Loop Error Handling Helpers
 *
 * Consolidates the repeated error handling logic used in all loop constructs
 * (for, c-style for, while, until).
 */
export type LoopAction = "break" | "continue" | "rethrow" | "error";
export interface LoopErrorResult {
    action: LoopAction;
    stdout: string;
    stderr: string;
    exitCode?: number;
    error?: unknown;
}
/**
 * Handle errors thrown during loop body execution.
 *
 * @param error - The caught error
 * @param stdout - Current accumulated stdout
 * @param stderr - Current accumulated stderr
 * @param loopDepth - Current loop nesting depth from ctx.state.loopDepth
 * @returns Result indicating what action the loop should take
 */
export declare function handleLoopError(error: unknown, stdout: string, stderr: string, loopDepth: number): LoopErrorResult;
