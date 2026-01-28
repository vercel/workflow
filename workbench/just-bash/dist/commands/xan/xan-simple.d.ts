/**
 * Simple commands: behead, sample, cat, search, flatmap, fmt
 */
import type { CommandContext, ExecResult } from "../../types.js";
/**
 * Behead: remove header row from CSV (output data rows only)
 * Usage: xan behead [FILE]
 */
export declare function cmdBehead(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * Sample: randomly sample N rows from CSV
 * Usage: xan sample [OPTIONS] <sample-size> [FILE]
 *   --seed SEED    Random seed for reproducibility
 */
export declare function cmdSample(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * Cat: concatenate CSV files
 * Usage: xan cat [OPTIONS] FILE1 FILE2 ...
 *   -p, --pad    Pad missing columns with empty values
 */
export declare function cmdCat(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * Search: filter rows by regex match on any/specific columns
 * Usage: xan search [OPTIONS] PATTERN [FILE]
 *   -s, --select COLS    Only search in these columns
 *   -v, --invert         Invert match (exclude matching rows)
 *   -i, --ignore-case    Case insensitive match
 */
export declare function cmdSearch(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * Flatmap: like map but expression can return multiple rows
 * Usage: xan flatmap EXPR [FILE]
 *   The expression should return an array; each element becomes a row
 */
export declare function cmdFlatmap(args: string[], ctx: CommandContext): Promise<ExecResult>;
/**
 * Fmt: format CSV as a table (alias for view with options)
 * Usage: xan fmt [OPTIONS] [FILE]
 */
export declare function cmdFmt(args: string[], ctx: CommandContext): Promise<ExecResult>;
