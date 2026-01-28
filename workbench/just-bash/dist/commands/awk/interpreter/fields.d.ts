/**
 * AWK Field Operations
 *
 * Handles $0, $1, $2, etc. field access and modification.
 */
import type { AwkRuntimeContext } from "./context.js";
import type { AwkValue } from "./types.js";
/**
 * Get a field value by index.
 * $0 is the whole line, $1 is first field, etc.
 */
export declare function getField(ctx: AwkRuntimeContext, index: number): AwkValue;
/**
 * Set a field value by index.
 * Setting $0 re-splits the line. Setting other fields rebuilds $0.
 */
export declare function setField(ctx: AwkRuntimeContext, index: number, value: AwkValue): void;
/**
 * Update context with a new line (used when processing input).
 */
export declare function setCurrentLine(ctx: AwkRuntimeContext, line: string): void;
/**
 * Update field separator and recompile regex.
 */
export declare function setFieldSeparator(ctx: AwkRuntimeContext, fs: string): void;
