/**
 * Grep spec test runner - executes parsed grep tests against just-bash's grep
 */
import { Bash } from "../../Bash.js";
import type { GrepTestCase } from "./parser.js";
export interface GrepTestResult {
    testCase: GrepTestCase;
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
 * Run a single grep test case
 */
export declare function runGrepTestCase(testCase: GrepTestCase, options?: RunOptions): Promise<GrepTestResult>;
/**
 * Format error message for debugging
 */
export declare function formatError(result: GrepTestResult): string;
