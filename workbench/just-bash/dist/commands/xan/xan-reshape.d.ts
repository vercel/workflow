/**
 * Reshape commands: explode, implode, flatmap, pivot, join, merge
 */
import type { CommandContext, ExecResult } from "../../types.js";
/**
 * Explode: split delimited column values into multiple rows
 * Usage: xan explode COLUMN [OPTIONS] [FILE]
 *   -s, --separator SEP  Value separator (default: |)
 *   --drop-empty         Drop rows where column is empty
 *   -r, --rename NAME    Rename the column
 */
export declare function cmdExplode(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * Implode: combine consecutive rows with same key, joining column values
 * Usage: xan implode COLUMN [OPTIONS] [FILE]
 *   -s, --separator SEP  Value separator (default: |)
 *   -r, --rename NAME    Rename the column
 */
export declare function cmdImplode(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * Join: join two CSV files on key columns
 * Usage: xan join KEY1 FILE1 KEY2 FILE2 [OPTIONS]
 *   --left       Left outer join (keep all rows from first file)
 *   --right      Right outer join (keep all rows from second file)
 *   --full       Full outer join (keep all rows from both files)
 *   -D, --default VALUE  Default value for missing fields
 */
export declare function cmdJoin(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * Pivot: reshape data by turning row values into columns
 * Usage: xan pivot COLUMN AGG_EXPR [OPTIONS] [FILE]
 *   -g, --groupby COLS   Group by these columns (default: all other columns)
 */
export declare function cmdPivot(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * Merge: merge multiple sorted CSV files
 * Usage: xan merge [OPTIONS] FILE1 FILE2 ...
 *   -s, --sort COLUMN   Sort column (files must be pre-sorted by this)
 */
export declare function cmdMerge(args: string[], ctx: CommandContext): Promise<ExecResult>;
