import type { KeySpec } from "./types.js";
/**
 * Parse a key specification like:
 * - "1" - field 1
 * - "1,2" - fields 1 through 2
 * - "1.3" - field 1 starting at char 3
 * - "1.3,2.5" - field 1 char 3 through field 2 char 5
 * - "1n" - field 1, numeric
 * - "1,2nr" - fields 1-2, numeric and reverse
 */
export declare function parseKeySpec(spec: string): KeySpec | null;
