/**
 * AWK Type Conversion Helpers
 *
 * Pure functions for type conversion and truthiness checking.
 */
import type { AwkValue } from "./types.js";
/**
 * Check if a value is truthy in AWK.
 * - Numbers: truthy if non-zero
 * - Empty string: falsy
 * - String "0": falsy (canonical string representation of zero)
 * - All other non-empty strings: truthy (including "00", "0.0", etc.)
 */
export declare function isTruthy(val: AwkValue): boolean;
/**
 * Convert an AWK value to a number.
 * Strings are parsed as floats, empty/non-numeric strings become 0.
 */
export declare function toNumber(val: AwkValue): number;
/**
 * Convert an AWK value to a string.
 * Numbers are formatted without trailing zeros.
 */
export declare function toAwkString(val: AwkValue): string;
/**
 * Check if a value looks like a number for comparison purposes.
 */
export declare function looksLikeNumber(val: AwkValue): boolean;
/**
 * Test if a string matches a regex pattern.
 */
export declare function matchRegex(pattern: string, text: string): boolean;
