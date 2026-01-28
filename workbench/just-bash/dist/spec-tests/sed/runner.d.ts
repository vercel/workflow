/**
 * SED spec test runner - executes parsed sed tests against just-bash's sed
 */
import { Bash } from "../../Bash.js";
import type { SedTestCase } from "./parser.js";
export interface SedTestResult {
    testCase: SedTestCase;
    passed: boolean;
    skipped: boolean;
    skipReason?: string;
    /** Test was expected to fail (skip) but unexpectedly passed */
    unexpectedPass?: boolean;
    actualOutput?: string;
    actualStderr?: string;
    actualStatus?: number;
    expectedOutput?: string;
    error?: string;
}
export interface RunOptions {
    /** Custom Bash options */
    bashEnvOptions?: ConstructorParameters<typeof Bash>[0];
}
/**
 * Run a single sed test case
 */
export declare function runSedTestCase(testCase: SedTestCase, options?: RunOptions): Promise<SedTestResult>;
/**
 * Format error message for debugging
 */
export declare function formatError(result: SedTestResult): string;
