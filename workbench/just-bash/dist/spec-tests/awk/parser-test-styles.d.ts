/**
 * Test parsing functions for specific onetrueawk test styles
 */
import type { AwkTestCase } from "./parser.js";
export interface ParseResult {
    testCase: AwkTestCase;
    nextLine: number;
}
/**
 * Extract a multi-line heredoc expected output (cat << \EOF ... EOF or cat <<! ... !)
 */
export declare function extractCatHeredoc(lines: string[], startLine: number): {
    content: string;
    endLine: number;
} | null;
/**
 * Try to parse a T.builtin style test:
 * $awk 'program' [input] >foo1
 * echo 'expected' >foo2
 * diff foo1 foo2 || echo 'BAD: testname'
 */
export declare function tryParseBuiltinStyleTest(lines: string[], startLine: number, tryParseMultiLineAwkTest: (lines: string[], startLine: number) => ParseResult | null): ParseResult | null;
/**
 * Try to parse a multi-line awk program test
 */
export declare function tryParseMultiLineAwkTest(lines: string[], startLine: number): ParseResult | null;
