/**
 * Readonly and export variable helpers.
 *
 * Consolidates readonly and export variable logic used in declare, export, local, etc.
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
/**
 * Mark a variable as readonly.
 */
export declare function markReadonly(ctx: InterpreterContext, name: string): void;
/**
 * Check if a variable is readonly.
 */
export declare function isReadonly(ctx: InterpreterContext, name: string): boolean;
/**
 * Check if a variable is readonly and throw an error if so.
 * Returns null if the variable is not readonly (can be modified).
 *
 * Assigning to a readonly variable is a fatal error that stops script execution.
 * This matches the behavior of dash, mksh, ash, and bash in POSIX mode.
 * (Note: bash in non-POSIX mode has a bug where multi-line readonly assignment
 * continues execution, but one-line still stops. We always stop.)
 *
 * @param ctx - Interpreter context
 * @param name - Variable name
 * @param command - Command name for error message (default: "bash")
 * @returns null if variable is not readonly (can be modified)
 * @throws ExitError if variable is readonly
 */
export declare function checkReadonlyError(ctx: InterpreterContext, name: string, command?: string): ExecResult | null;
/**
 * Mark a variable as exported.
 *
 * If we're inside a local scope and the variable is local (exists in the
 * current scope), track it as a locally-exported variable. When the scope
 * is popped, the export attribute will be removed if it wasn't exported
 * before entering the function.
 */
export declare function markExported(ctx: InterpreterContext, name: string): void;
/**
 * Remove the export attribute from a variable.
 * The variable value is preserved, just no longer exported to child processes.
 */
export declare function unmarkExported(ctx: InterpreterContext, name: string): void;
