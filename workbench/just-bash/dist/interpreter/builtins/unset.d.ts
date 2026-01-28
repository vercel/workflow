/**
 * unset - Remove variables/functions builtin
 *
 * Supports:
 * - unset VAR - remove variable
 * - unset -v VAR - remove variable (explicit)
 * - unset -f FUNC - remove function
 * - unset 'a[i]' - remove array element (with arithmetic index support)
 *
 * Bash-specific unset scoping:
 * - local-unset (same scope): value-unset - clears value but keeps local cell
 * - dynamic-unset (different scope): cell-unset - removes local cell, exposes outer value
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleUnset(ctx: InterpreterContext, args: string[]): Promise<ExecResult>;
