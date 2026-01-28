/**
 * Filter and sort commands: filter, sort, dedup, top
 */
import type { CommandContext, ExecResult } from "../../types.js";
export declare function cmdFilter(args: string[], ctx: CommandContext): Promise<ExecResult>;
export declare function cmdSort(args: string[], ctx: CommandContext): Promise<ExecResult>;
export declare function cmdDedup(args: string[], ctx: CommandContext): Promise<ExecResult>;
export declare function cmdTop(args: string[], ctx: CommandContext): Promise<ExecResult>;
