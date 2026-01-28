/**
 * Shared utilities for allow-list e2e tests
 *
 * This module provides:
 * - Mock fetch implementation with predefined responses
 * - Environment adapters for BashEnv and Sandbox
 * - Test utilities like expectBlocked
 */
import { vi } from "vitest";
import type { BashOptions } from "../../Bash.js";
export declare const MOCK_SUCCESS_BODY: string;
export declare const MOCK_USERS_BODY: string;
export declare const MOCK_POSTS_BODY: string;
export declare const MOCK_FILE_BODY: string;
export declare const MOCK_EVIL_BODY: string;
export declare const originalFetch: typeof fetch;
export declare function createMockFetch(): ReturnType<typeof vi.fn<typeof fetch>>;
/**
 * Environment adapter interface for running tests with both BashEnv and Sandbox
 */
export interface EnvAdapter {
    exec(cmd: string): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
    readFile(path: string): Promise<string>;
}
/**
 * Creates an adapter for BashEnv
 */
export declare function createBashEnvAdapter(options: BashOptions): EnvAdapter;
/**
 * Creates an adapter for Sandbox
 */
export declare function createSandboxAdapter(options: BashOptions): Promise<EnvAdapter>;
export type AdapterFactory = (options: BashOptions) => EnvAdapter | Promise<EnvAdapter>;
/**
 * Utility for testing that a URL is blocked
 */
export declare function expectBlocked(env: EnvAdapter, url: string, expectedUrl?: string): Promise<void>;
/**
 * Utility for testing that a URL succeeds with expected mock response
 */
export declare function expectAllowed(env: EnvAdapter, url: string, expectedBody: string): Promise<void>;
