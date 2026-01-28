/**
 * Word Part Helper Functions
 *
 * Provides common operations on WordPart types to eliminate duplication
 * across expansion.ts and word-parser.ts.
 */
import type { WordPart } from "../../ast/types.js";
/**
 * Get the literal string value from a word part.
 * Returns the value for Literal, SingleQuoted, and Escaped parts.
 * Returns null for complex parts that require expansion.
 */
export declare function getLiteralValue(part: WordPart): string | null;
/**
 * Check if a word part is "quoted" - meaning glob characters should be treated literally.
 * A part is quoted if it is:
 * - SingleQuoted
 * - Escaped
 * - DoubleQuoted (entirely quoted)
 * - Literal with empty value (doesn't affect quoting)
 */
export declare function isQuotedPart(part: WordPart): boolean;
