/**
 * Parser for Oils spec test format (.test.sh files)
 *
 * Format:
 * - File headers: `## key: value`
 * - Test cases start with: `#### Test Name`
 * - Assertions: `## stdout:`, `## status:`, `## STDOUT: ... ## END`
 * - Shell-specific: `## OK shell`, `## N-I shell`, `## BUG shell`
 */
export interface FileHeader {
    oilsFailuresAllowed?: number;
    compareShells?: string[];
    tags?: string[];
}
export interface Assertion {
    type: "stdout" | "stderr" | "status" | "stdout-json" | "stderr-json";
    value: string | number;
    shells?: string[];
    variant?: "OK" | "N-I" | "BUG";
}
export interface TestCase {
    name: string;
    script: string;
    assertions: Assertion[];
    lineNumber: number;
    skip?: string;
}
export interface ParsedSpecFile {
    header: FileHeader;
    testCases: TestCase[];
    filePath: string;
}
/**
 * Parse a spec test file content
 */
export declare function parseSpecFile(content: string, filePath: string): ParsedSpecFile;
/**
 * Get the expected stdout for a test case (considering bash-specific variants)
 */
export declare function getExpectedStdout(testCase: TestCase): string | null;
/**
 * Get the expected stderr for a test case
 */
export declare function getExpectedStderr(testCase: TestCase): string | null;
/**
 * Get the expected exit status for a test case
 * Returns the default expected status (ignoring OK variants which are alternates)
 */
export declare function getExpectedStatus(testCase: TestCase): number | null;
/**
 * Get all acceptable stdout values for a test case
 * This includes the default stdout and any OK variants for bash
 */
export declare function getAcceptableStdouts(testCase: TestCase): string[];
/**
 * Get all acceptable stderr values for a test case
 * This includes the default stderr and any OK variants for bash
 */
export declare function getAcceptableStderrs(testCase: TestCase): string[];
/**
 * Get all acceptable exit statuses for a test case
 * This includes the default status and any OK variants for bash
 */
export declare function getAcceptableStatuses(testCase: TestCase): number[];
/**
 * Check if a test case is marked as N-I (Not Implemented) for bash
 */
export declare function isNotImplementedForBash(testCase: TestCase): boolean;
