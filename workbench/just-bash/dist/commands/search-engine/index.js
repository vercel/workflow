/**
 * Shared search engine for grep and rg commands
 *
 * Provides core text searching functionality:
 * - Line-by-line content matching
 * - Context lines (before/after)
 * - Regex building for different modes (basic, extended, fixed, perl)
 */
export { searchContent, } from "./matcher.js";
export { buildRegex, convertReplacement, } from "./regex.js";
