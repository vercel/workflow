/**
 * Skip list for grep spec tests
 *
 * Tests in this list are expected to fail. If a test passes unexpectedly,
 * the test runner will report it as a failure so we know to remove it from the skip list.
 */
/**
 * Get skip reason for a test
 */
export declare function getSkipReason(fileName: string, testName: string, command?: string): string | undefined;
/**
 * Check if entire file should be skipped
 */
export declare function isFileSkipped(fileName: string): boolean;
