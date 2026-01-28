/**
 * Parser for jq test format
 *
 * The jq test format is simple:
 * - Tests are groups of three lines: program, input, expected output
 * - Blank lines and lines starting with # are ignored
 * - Multiple expected output lines mean multiple outputs
 * - %%FAIL indicates an error test
 */
export interface JqTestCase {
    name: string;
    /** The jq program to run */
    program: string;
    /** Input JSON */
    input: string;
    /** Expected outputs (may be multiple) */
    expectedOutputs: string[];
    /** If true, test expects an error */
    expectsError: boolean;
    /** Expected error message (if expectsError) */
    expectedError?: string;
    /** Line number in source file */
    lineNumber: number;
    /** If set, test is expected to fail (value is reason) */
    skip?: string;
}
export interface ParsedJqTestFile {
    fileName: string;
    filePath: string;
    testCases: JqTestCase[];
}
/**
 * Parse a jq test file
 */
export declare function parseJqTestFile(content: string, filePath: string): ParsedJqTestFile;
