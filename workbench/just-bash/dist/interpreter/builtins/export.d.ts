/**
 * export - Set environment variables builtin
 *
 * Usage:
 *   export              - List all exported variables
 *   export -p           - List all exported variables (same as no args)
 *   export NAME=value   - Set and export variable
 *   export NAME+=value  - Append value and export variable
 *   export NAME         - Export existing variable (or create empty)
 *   export -n NAME      - Un-export variable (remove from env)
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleExport(ctx: InterpreterContext, args: string[]): ExecResult;
