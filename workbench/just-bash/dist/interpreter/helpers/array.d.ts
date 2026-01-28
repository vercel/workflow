/**
 * Array helper functions for the interpreter.
 */
import type { WordNode } from "../../ast/types.js";
import type { InterpreterContext } from "../types.js";
/**
 * Get all indices of an array, sorted in ascending order.
 * Arrays are stored as `name_0`, `name_1`, etc. in the environment.
 */
export declare function getArrayIndices(ctx: InterpreterContext, arrayName: string): number[];
/**
 * Clear all elements of an array from the environment.
 */
export declare function clearArray(ctx: InterpreterContext, arrayName: string): void;
/**
 * Get all keys of an associative array.
 * For associative arrays, keys are stored as `name_key` where key is a string.
 */
export declare function getAssocArrayKeys(ctx: InterpreterContext, arrayName: string): string[];
/**
 * Remove surrounding quotes from a key string.
 * Handles 'key' and "key" → key
 */
export declare function unquoteKey(key: string): string;
/**
 * Parse a keyed array element from an AST WordNode like [key]=value or [key]+=value.
 * Returns { key, valueParts, append } where valueParts are the AST parts for the value.
 * Returns null if not a keyed element pattern.
 *
 * This is used to properly expand variables in the value part of keyed elements.
 */
export interface ParsedKeyedElement {
    key: string;
    valueParts: WordNode["parts"];
    append: boolean;
}
export declare function parseKeyedElementFromWord(word: WordNode): ParsedKeyedElement | null;
/**
 * Extract literal string content from a Word node (without expansion).
 * This is used for parsing associative array element syntax like [key]=value
 * where the [key] part may be parsed as a Glob.
 */
export declare function wordToLiteralString(word: WordNode): string;
