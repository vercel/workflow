/**
 * Query Value Utilities
 *
 * Utility functions for working with jq/query values.
 */
export type QueryValue = unknown;
/**
 * Check if a value is truthy in jq semantics.
 * In jq: false and null are falsy, everything else is truthy.
 */
export declare function isTruthy(v: QueryValue): boolean;
/**
 * Deep equality check for query values.
 */
export declare function deepEqual(a: QueryValue, b: QueryValue): boolean;
/**
 * Compare two values for sorting.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export declare function compare(a: QueryValue, b: QueryValue): number;
/**
 * Deep merge two objects.
 * Values from b override values from a, except nested objects are merged recursively.
 */
export declare function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown>;
/**
 * Calculate the nesting depth of a value (array or object).
 */
export declare function getValueDepth(value: QueryValue, maxCheck?: number): number;
/**
 * Compare two values using jq's comparison semantics.
 * jq sorts by type first (null < bool < number < string < array < object),
 * then by value within type.
 */
export declare function compareJq(a: QueryValue, b: QueryValue): number;
/**
 * Check if value a contains value b using jq's containment semantics.
 */
export declare function containsDeep(a: QueryValue, b: QueryValue): boolean;
