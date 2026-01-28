/**
 * complete - Set and display programmable completion specifications
 *
 * Usage:
 *   complete                        - List all completion specs
 *   complete -p                     - Print all completion specs in reusable format
 *   complete -p cmd                 - Print completion spec for specific command
 *   complete -W 'word1 word2' cmd   - Set word list completion for cmd
 *   complete -F func cmd            - Set function completion for cmd
 *   complete -r cmd                 - Remove completion spec for cmd
 *   complete -r                     - Remove all completion specs
 *   complete -D ...                 - Set default completion (for commands with no specific spec)
 *   complete -o opt cmd             - Set completion options (nospace, filenames, default, etc.)
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleComplete(ctx: InterpreterContext, args: string[]): ExecResult;
