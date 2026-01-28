/**
 * Word Analysis
 *
 * Functions for analyzing word parts to determine what types of expansions are present.
 */
import type { ParameterExpansionPart, WordPart } from "../../ast/types.js";
/**
 * Check if a glob pattern string contains variable references ($var or ${var})
 * This is used to detect when IFS splitting should apply to expanded glob patterns.
 */
export declare function globPatternHasVarRef(pattern: string): boolean;
/**
 * Check if a parameter expansion's operation word is entirely quoted (all parts are quoted).
 * This is different from hasQuotedOperationWord which returns true if ANY part is quoted.
 *
 * For word splitting purposes:
 * - ${v:-"AxBxC"} - entirely quoted, should NOT be split
 * - ${v:-x"AxBxC"x} - mixed quoted/unquoted, SHOULD be split (on unquoted parts)
 * - ${v:-AxBxC} - entirely unquoted, SHOULD be split
 */
export declare function isOperationWordEntirelyQuoted(part: ParameterExpansionPart): boolean;
/**
 * Result of analyzing word parts
 */
export interface WordPartsAnalysis {
    hasQuoted: boolean;
    hasCommandSub: boolean;
    hasArrayVar: boolean;
    hasArrayAtExpansion: boolean;
    hasParamExpansion: boolean;
    hasVarNamePrefixExpansion: boolean;
    hasIndirection: boolean;
}
/**
 * Analyze word parts for expansion behavior
 */
export declare function analyzeWordParts(parts: WordPart[]): WordPartsAnalysis;
