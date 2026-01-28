/**
 * Map command: add computed columns
 */
import type { CommandContext, ExecResult } from "../../types.js";
export declare function cmdMap(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * Transform command: modify existing columns in-place
 * Usage: xan transform COLUMN EXPR [FILE]
 *   -r, --rename NAME  Rename the column after transformation
 */
export declare function cmdTransform(args: string[], ctx: CommandContext): Promise<ExecResult>;
