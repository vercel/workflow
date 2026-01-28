/**
 * Format-related jq builtins (@ prefixed)
 *
 * Handles encoding/formatting functions like @base64, @uri, @csv, @json, etc.
 */
import type { QueryValue } from "../value-operations.js";
/**
 * Handle format builtins (those starting with @).
 * Returns null if the builtin name is not a format builtin handled here.
 */
export declare function evalFormatBuiltin(value: QueryValue, name: string, maxDepth?: number): QueryValue[] | null;
