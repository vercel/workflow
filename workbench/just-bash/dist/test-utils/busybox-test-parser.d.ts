/**
 * Shared parser for BusyBox test format
 *
 * BusyBox format: testing "description" "commands" "result" "infile" "stdin"
 *
 * This parser is used by both sed-spec-tests and grep-spec-tests.
 */
export interface BusyBoxTestCase {
    name: string;
    /** The shell command to run */
    command: string;
    /** Expected stdout */
    expectedOutput: string;
    /** Content for input file (if any) */
    infile: string;
    /** Content for stdin (if any) */
    stdin: string;
    /** Line number in source file */
    lineNumber: number;
    /** If set, test is expected to fail (value is reason) */
    skip?: string;
}
export interface ParsedBusyBoxTestFile {
    fileName: string;
    filePath: string;
    testCases: BusyBoxTestCase[];
}
/**
 * Parse BusyBox test format
 *
 * Format: testing "description" "commands" "result" "infile" "stdin"
 */
export declare function parseBusyBoxTests(content: string, filePath: string): ParsedBusyBoxTestFile;
