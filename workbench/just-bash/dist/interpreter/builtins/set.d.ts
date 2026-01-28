/**
 * set - Set/unset shell options builtin
 *
 * In POSIX mode (set -o posix), errors from set (like invalid options)
 * cause the script to exit immediately.
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleSet(ctx: InterpreterContext, args: string[]): ExecResult;
