import type { SedCommand, SedExecutionLimits, SedState } from "./types.js";
export declare function createInitialState(totalLines: number, filename?: string, rangeStates?: Map<string, import("./types.js").RangeState>): SedState;
export interface ExecuteContext {
    lines: string[];
    currentLineIndex: number;
}
export declare function executeCommands(commands: SedCommand[], state: SedState, ctx?: ExecuteContext, limits?: SedExecutionLimits): number;
