/**
 * mapfile/readarray - Read lines from stdin into an array
 *
 * Usage: mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [array]
 *        readarray [-d delim] [-n count] [-O origin] [-s count] [-t] [array]
 *
 * Options:
 *   -d delim   Use delim as line delimiter (default: newline)
 *   -n count   Read at most count lines (0 = all)
 *   -O origin  Start assigning at index origin (default: 0)
 *   -s count   Skip first count lines
 *   -t         Remove trailing delimiter from each line
 *   array      Array name (default: MAPFILE)
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleMapfile(ctx: InterpreterContext, args: string[], stdin: string): ExecResult;
