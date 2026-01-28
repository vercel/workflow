/**
 * Spec test runner - executes parsed spec tests against Bash
 */
import { Bash } from "../Bash.js";
import { type ParsedSpecFile, type TestCase } from "./parser.js";
export interface TestResult {
    testCase: TestCase;
    passed: boolean;
    skipped: boolean;
    skipReason?: string;
    /** Test was expected to fail (## SKIP) but unexpectedly passed */
    unexpectedPass?: boolean;
    actualStdout?: string;
    actualStderr?: string;
    actualStatus?: number;
    expectedStdout?: string | null;
    expectedStderr?: string | null;
    expectedStatus?: number | null;
    error?: string;
    /** File path for the test file (used for UNEXPECTED PASS fix commands) */
    filePath?: string;
}
export interface RunOptions {
    /** Only run tests matching this pattern */
    filter?: RegExp;
    /** Custom Bash options */
    bashEnvOptions?: ConstructorParameters<typeof Bash>[0];
    /** File path for the test file */
    filePath?: string;
}
/**
 * Run a single test case
 */
export declare function runTestCase(testCase: TestCase, options?: RunOptions): Promise<TestResult>;
/**
 * Run all tests in a parsed spec file
 */
export declare function runSpecFile(specFile: ParsedSpecFile, options?: RunOptions): Promise<TestResult[]>;
/**
 * Get summary statistics for test results
 */
export declare function getResultsSummary(results: TestResult[]): {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
};
