/**
 * compgen - Generate completion matches
 *
 * Usage:
 *   compgen -v [prefix]         - List variable names (optionally starting with prefix)
 *   compgen -A variable [prefix] - Same as -v
 *   compgen -A function [prefix] - List function names
 *   compgen -e [prefix]          - List exported variable names
 *   compgen -A builtin [prefix]  - List builtin command names
 *   compgen -A keyword [prefix]  - List shell keywords (alias: -k)
 *   compgen -A alias [prefix]    - List alias names
 *   compgen -A shopt [prefix]    - List shopt options
 *   compgen -A helptopic [prefix] - List help topics
 *   compgen -A directory [prefix] - List directory names
 *   compgen -A file [prefix]      - List file names
 *   compgen -f [prefix]           - List file names (alias for -A file)
 *   compgen -A user               - List user names
 *   compgen -A command [prefix]   - List commands (builtins, functions, aliases, external)
 *   compgen -W wordlist [prefix]  - Generate from wordlist
 *   compgen -P prefix             - Prefix to add to completions
 *   compgen -S suffix             - Suffix to add to completions
 *   compgen -o option             - Completion option (plusdirs, dirnames, default, etc.)
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleCompgen(ctx: InterpreterContext, args: string[]): Promise<ExecResult>;
