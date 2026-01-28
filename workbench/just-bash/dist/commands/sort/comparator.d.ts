import type { SortOptions } from "./types.js";
/**
 * Create a comparison function for sorting
 */
export declare function createComparator(options: SortOptions): (a: string, b: string) => number;
/**
 * Filter unique lines based on key values or whole line
 */
export declare function filterUnique(lines: string[], options: SortOptions): string[];
