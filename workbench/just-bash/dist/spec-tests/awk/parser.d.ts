/**
 * Parser for onetrueawk test format (T.* shell scripts)
 *
 * The onetrueawk test suite uses shell scripts with patterns like:
 * - $awk 'program' [input] >foo1
 * - echo 'expected' >foo2
 * - diff foo1 foo2 || echo 'BAD: testname'
 *
 * This parser extracts individual test cases from these scripts.
 */
export interface AwkTestCase {
    name: string;
    /** The awk program to run */
    program: string;
    /** Input data (stdin or file content) */
    input: string;
    /** Expected stdout */
    expectedOutput: string;
    /** Expected exit status (default 0) */
    expectedStatus?: number;
    /** Line number in source file */
    lineNumber: number;
    /** If set, test is expected to fail (value is reason) */
    skip?: string;
    /** Original shell command for reference */
    originalCommand?: string;
    /** Field separator to use (default is space/whitespace) */
    fieldSeparator?: string;
    /** Command-line arguments to pass to awk (for ARGV/ARGC tests) */
    args?: string[];
    /** Command-line variable assignments via -v var=value */
    vars?: Record<string, string>;
}
export interface ParsedAwkTestFile {
    fileName: string;
    filePath: string;
    testCases: AwkTestCase[];
    /** Tests that couldn't be parsed */
    unparsedTests: string[];
}
/**
 * Parse a T.* shell test file
 */
export declare function parseAwkTestFile(content: string, filePath: string): ParsedAwkTestFile;
