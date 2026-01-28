/**
 * Aggregation commands: agg, groupby, frequency, stats
 */
import type { CommandContext, ExecResult } from "../../types.js";
export declare function cmdAgg(args: string[], ctx: CommandContext): Promise<ExecResult>;
export declare function cmdGroupby(args: string[], ctx: CommandContext): Promise<ExecResult>;
export declare function cmdFrequency(args: string[], ctx: CommandContext): Promise<ExecResult>;
export declare function cmdStats(args: string[], ctx: CommandContext): Promise<ExecResult>;
