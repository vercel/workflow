/**
 * AWK spec test runner - executes parsed awk tests against just-bash's awk
 */
import { Bash } from "../../Bash.js";
import type { AwkTestCase } from "./parser.js";
export interface AwkTestResult {
    testCase: AwkTestCase;
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
 * Run a single awk test case
 */
export declare function runAwkTestCase(testCase: AwkTestCase, options?: RunOptions): Promise<AwkTestResult>;
/**
 * Format error message for debugging
 */
export declare function formatError(result: AwkTestResult): string;
