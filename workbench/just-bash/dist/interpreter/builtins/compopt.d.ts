/**
 * compopt - Modify completion options
 *
 * Usage:
 *   compopt [-o option] [+o option] [name ...]
 *   compopt -D [-o option] [+o option]
 *   compopt -E [-o option] [+o option]
 *
 * Modifies completion options for the specified commands (names) or the
 * currently executing completion when no names are provided.
 *
 * Options:
 *   -o option  Enable completion option
 *   +o option  Disable completion option
 *   -D         Apply to default completion
 *   -E         Apply to empty-line completion
 *
 * Valid completion options:
 *   bashdefault, default, dirnames, filenames, noquote, nosort, nospace, plusdirs
 *
 * Returns:
 *   0 on success
 *   1 if not in a completion function and no command name is given
 *   2 if an invalid option is specified
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleCompopt(ctx: InterpreterContext, args: string[]): ExecResult;
