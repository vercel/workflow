/**
 * Column operation commands: select, drop, rename, enum
 */
import type { CommandContext, ExecResult } from "../../types.js";
export declare function cmdSelect(args: string[], ctx: CommandContext): Promise<ExecResult>;
export declare function cmdDrop(args: string[], ctx: CommandContext): Promise<ExecResult>;
export declare function cmdRename(args: string[], ctx: CommandContext): Promise<ExecResult>;
export declare function cmdEnum(args: string[], ctx: CommandContext): Promise<ExecResult>;
