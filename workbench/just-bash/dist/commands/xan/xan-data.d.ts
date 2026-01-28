/**
 * Data utility commands: transpose, shuffle, fixlengths, split, partition
 * Commands that exist in real xan
 */
import type { CommandContext, ExecResult } from "../../types.js";
/**
 * Transpose: swap rows and columns
 * Usage: xan transpose [FILE]
 *   First column becomes header row, first row becomes header column
 */
export declare function cmdTranspose(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * Shuffle: randomly reorder rows
 * Usage: xan shuffle [OPTIONS] [FILE]
 *   --seed N    Random seed for reproducibility
 */
export declare function cmdShuffle(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * Fixlengths: fix ragged CSV by padding/truncating rows
 * Usage: xan fixlengths [OPTIONS] [FILE]
 *   -l, --length N    Target number of columns (default: max row length)
 *   -d, --default V   Default value for missing fields (default: empty)
 */
export declare function cmdFixlengths(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * Split: split CSV into multiple files by row count
 * Usage: xan split [OPTIONS] FILE
 *   -c, --chunks N    Split into N equal chunks
 *   -S, --size N      Split into chunks of N rows each
 *   -o, --output DIR  Output directory (default: current)
 *
 * In sandbox mode, outputs as JSON with parts as array
 */
export declare function cmdSplit(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * Partition: split CSV by column value into separate outputs
 * Usage: xan partition COLUMN [OPTIONS] [FILE]
 *   -o, --output DIR  Output directory (default: current)
 */
export declare function cmdPartition(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * To: convert CSV to other formats
 * Usage: xan to FORMAT [OPTIONS] [FILE]
 *   FORMAT: json
 */
export declare function cmdTo(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * From: convert other formats to CSV
 * Usage: xan from [OPTIONS] [FILE]
 *   -f, --format FORMAT   Input format (json)
 */
export declare function cmdFrom(args: string[], ctx: CommandContext): Promise<ExecResult>;
