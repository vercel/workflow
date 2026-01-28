/**
 * Command Substitution Helpers
 *
 * Helper functions for handling command substitution patterns.
 */
import type { ScriptNode, WordNode } from "../../ast/types.js";
/**
 * Check if a command substitution body matches the $(<file) shorthand pattern.
 * This is a special case where $(< file) is equivalent to $(cat file) but reads
 * the file directly without spawning a subprocess.
 *
 * For this to match, the body must consist of:
 * - One statement without operators (no && or ||)
 * - One pipeline with one command
 * - A SimpleCommand with no name, no args, no assignments
 * - Exactly one input redirection (<)
 *
 * Note: The special $(<file) behavior only works when it's the ONLY element
 * in the command substitution. $(< file; cmd) or $(cmd; < file) are NOT special.
 */
export declare function getFileReadShorthand(body: ScriptNode): {
    target: WordNode;
} | null;
