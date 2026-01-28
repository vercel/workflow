/**
 * Assignment Expansion Helpers
 *
 * Handles expansion of assignment arguments for local/declare/typeset builtins.
 * - Array assignments: name=(elem1 elem2 ...)
 * - Scalar assignments: name=value, name+=value, name[index]=value
 */
import type { WordNode } from "../ast/types.js";
import type { InterpreterContext } from "./types.js";
/**
 * Check if a Word represents an array assignment (name=(...)) and expand it
 * while preserving quote structure for elements.
 * Returns the expanded string like "name=(elem1 elem2 ...)" or null if not an array assignment.
 */
export declare function expandLocalArrayAssignment(ctx: InterpreterContext, word: WordNode): Promise<string | null>;
/**
 * Check if a Word represents a scalar assignment (name=value, name+=value, or name[index]=value)
 * and expand it WITHOUT glob expansion on the value part.
 * Returns the expanded string like "name=expanded_value" or null if not a scalar assignment.
 *
 * This is important for bash compatibility: `local var=$x` where x='a b' should
 * set var to "a b", not try to glob-expand it.
 */
export declare function expandScalarAssignmentArg(ctx: InterpreterContext, word: WordNode): Promise<string | null>;
