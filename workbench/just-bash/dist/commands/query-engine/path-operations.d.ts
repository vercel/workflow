/**
 * Query Path Utilities
 *
 * Utility functions for path-based operations on query values.
 */
import type { QueryValue } from "./value-operations.js";
/**
 * Set a value at a given path within a query value.
 * Creates intermediate arrays/objects as needed.
 */
export declare function setPath(value: QueryValue, path: (string | number)[], newVal: QueryValue): QueryValue;
/**
 * Delete a value at a given path within a query value.
 */
export declare function deletePath(value: QueryValue, path: (string | number)[]): QueryValue;
