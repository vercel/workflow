/**
 * Variable Attributes
 *
 * Functions for getting variable attributes (${var@a} transformation).
 */
import type { InterpreterContext } from "../types.js";
/**
 * Get the attributes of a variable for ${var@a} transformation.
 * Returns a string with attribute flags (e.g., "ar" for readonly array).
 *
 * Attribute flags (in order):
 * - a: indexed array
 * - A: associative array
 * - i: integer
 * - n: nameref
 * - r: readonly
 * - x: exported
 */
export declare function getVariableAttributes(ctx: InterpreterContext, name: string): string;
