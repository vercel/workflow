import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Bash } from "../Bash.js";
/**
 * Check if we're in record mode (recording bash outputs to fixtures)
 * - "1" = record mode, but skip locked fixtures
 * - "force" = record mode, overwrite even locked fixtures
 */
export declare const isRecordMode: boolean;
/**
 * Fixture entry for a single test case
 */
export interface FixtureEntry {
    command: string;
    files: Record<string, string>;
    stdout: string;
    stderr: string;
    exitCode: number;
    /**
     * If true, this fixture has been manually adjusted (e.g., for Linux behavior)
     * and will not be overwritten during recording unless RECORD_FIXTURES=force
     */
    locked?: boolean;
}
/**
 * Fixtures file format - keyed by fixture ID
 */
export interface FixturesFile {
    [fixtureId: string]: FixtureEntry;
}
/**
 * Write all pending fixtures to disk (call after all tests complete)
 */
export declare function writeAllFixtures(): Promise<void>;
/**
 * Creates a unique temp directory for testing
 */
export declare function createTestDir(): Promise<string>;
/**
 * Cleans up the temp directory
 */
export declare function cleanupTestDir(testDir: string): Promise<void>;
/**
 * Options for comparing outputs
 */
export interface CompareOptions {
    compareStderr?: boolean;
    compareExitCode?: boolean;
    normalizeWhitespace?: boolean;
}
/**
 * Sets up test files in both real FS and creates a BashEnv
 */
export declare function setupFiles(testDir: string, files: Record<string, string>): Promise<Bash>;
/**
 * Runs a command in real bash
 */
export declare function runRealBash(command: string, cwd: string): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
}>;
/**
 * Compares BashEnv output with recorded bash output (from fixtures)
 * In record mode, runs real bash and saves the output to fixtures
 *
 * @param env - BashEnv instance
 * @param testDir - Test directory path
 * @param command - Command to run
 * @param options - Comparison options (optional)
 * @param files - Files that were set up (optional, auto-retrieved from setupFiles registry)
 * @param testFileUrl - import.meta.url of the test file (optional, falls back to stack trace)
 */
export declare function compareOutputs(env: Bash, testDir: string, command: string, options?: CompareOptions, files?: Record<string, string>, testFileUrl?: string): Promise<void>;
export { path, fs };
