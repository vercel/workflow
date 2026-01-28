/**
 * help - Display helpful information about builtin commands
 *
 * Usage: help [-s] [pattern ...]
 *
 * If PATTERN is specified, gives detailed help on all commands matching PATTERN,
 * otherwise a list of the builtins is printed. The -s option restricts the output
 * for each builtin command matching PATTERN to a short usage synopsis.
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleHelp(_ctx: InterpreterContext, args: string[]): ExecResult;
