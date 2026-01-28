/**
 * Type-related jq builtins
 *
 * Handles type checking and type filtering functions like type, numbers, strings, etc.
 */
import type { QueryValue } from "../value-operations.js";
/**
 * Handle type builtins.
 * Returns null if the builtin name is not a type builtin handled here.
 */
export declare function evalTypeBuiltin(value: QueryValue, name: string): QueryValue[] | null;
