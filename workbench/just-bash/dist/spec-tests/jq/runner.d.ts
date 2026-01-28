/**
 * JQ spec test runner - executes parsed jq tests against just-bash's jq
 */
import { Bash } from "../../Bash.js";
import type { JqTestCase } from "./parser.js";
export interface JqTestResult {
    testCase: JqTestCase;
    passed: boolean;
    skipped: boolean;
    skipReason?: string;
    /** Test was expected to fail (skip) but unexpectedly passed */
    unexpectedPass?: boolean;
    actualOutputs?: string[];
    actualStderr?: string;
    actualStatus?: number;
    expectedOutputs?: string[];
    error?: string;
}
export interface RunOptions {
    /** Custom Bash options */
    bashEnvOptions?: ConstructorParameters<typeof Bash>[0];
}
/**
 * Run a single jq test case
 */
export declare function runJqTestCase(testCase: JqTestCase, options?: RunOptions): Promise<JqTestResult>;
/**
 * Format error message for debugging
 */
export declare function formatError(result: JqTestResult): string;
