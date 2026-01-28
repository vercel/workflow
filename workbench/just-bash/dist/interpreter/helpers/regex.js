/**
 * Regex helper functions for the interpreter.
 */
/**
 * Escape a string for use as a literal in a regex pattern.
 * All regex special characters are escaped.
 */
export function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
