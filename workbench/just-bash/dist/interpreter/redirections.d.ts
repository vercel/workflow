/**
 * Redirection Handling
 *
 * Handles output redirections:
 * - > : Write stdout to file
 * - >> : Append stdout to file
 * - 2> : Write stderr to file
 * - &> : Write both stdout and stderr to file
 * - >& : Redirect fd to another fd
 * - {fd}>file : Allocate FD and store in variable
 */
import type { RedirectionNode } from "../ast/types.js";
import type { ExecResult } from "../types.js";
import type { InterpreterContext } from "./types.js";
/**
 * Pre-expanded redirect targets, keyed by index into the redirections array.
 * This allows us to expand redirect targets (including side effects) before
 * executing a function body, then apply the redirections after.
 */
export type ExpandedRedirectTargets = Map<number, string>;
/**
 * Pre-expand redirect targets for function definitions.
 * This is needed because redirections on function definitions are evaluated
 * each time the function is called, and any side effects (like $((i++)))
 * must occur BEFORE the function body executes.
 */
export declare function preExpandRedirectTargets(ctx: InterpreterContext, redirections: RedirectionNode[]): Promise<{
    targets: ExpandedRedirectTargets;
    error?: string;
}>;
/**
 * Process FD variable redirections ({varname}>file syntax).
 * This allocates FDs and sets variables before command execution.
 * Returns an error result if there's an issue, or null if successful.
 */
export declare function processFdVariableRedirections(ctx: InterpreterContext, redirections: RedirectionNode[]): Promise<ExecResult | null>;
/**
 * Pre-open (truncate) output redirect files before command execution.
 * This is needed for compound commands (subshell, for, case, [[) where
 * bash opens/truncates the redirect file BEFORE evaluating any words in
 * the command body (including command substitutions).
 *
 * Example: `(echo \`cat FILE\`) > FILE`
 * - Bash first truncates FILE (making it empty)
 * - Then executes the subshell, where `cat FILE` returns empty string
 *
 * Returns an error result if there's an issue (like directory or noclobber),
 * or null if pre-opening succeeded.
 */
export declare function preOpenOutputRedirects(ctx: InterpreterContext, redirections: RedirectionNode[]): Promise<ExecResult | null>;
export declare function applyRedirections(ctx: InterpreterContext, result: ExecResult, redirections: RedirectionNode[], preExpandedTargets?: ExpandedRedirectTargets): Promise<ExecResult>;
