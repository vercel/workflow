/**
 * shift - Shift positional parameters
 *
 * shift [n]
 *
 * Shifts positional parameters to the left by n (default 1).
 * $n+1 becomes $1, $n+2 becomes $2, etc.
 * $# is decremented by n.
 *
 * In POSIX mode (set -o posix), errors from shift (like shift count
 * exceeding available parameters) cause the script to exit immediately.
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleShift(ctx: InterpreterContext, args: string[]): ExecResult;
