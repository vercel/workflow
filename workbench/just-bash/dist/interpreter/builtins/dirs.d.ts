/**
 * Directory Stack Builtins: pushd, popd, dirs
 *
 * pushd [dir] - Push directory onto stack and cd to it
 * popd - Pop directory from stack and cd to previous
 * dirs [-clpv] - Display directory stack
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
/**
 * pushd - Push directory onto stack and cd to it
 *
 * pushd [dir] - Push current dir, cd to dir
 */
export declare function handlePushd(ctx: InterpreterContext, args: string[]): Promise<ExecResult>;
/**
 * popd - Pop directory from stack and cd to it
 */
export declare function handlePopd(ctx: InterpreterContext, args: string[]): ExecResult;
/**
 * dirs - Display directory stack
 *
 * dirs [-clpv]
 *   -c: Clear the stack
 *   -l: Long format (no tilde substitution)
 *   -p: One entry per line
 *   -v: One entry per line with index numbers
 */
export declare function handleDirs(ctx: InterpreterContext, args: string[]): ExecResult;
