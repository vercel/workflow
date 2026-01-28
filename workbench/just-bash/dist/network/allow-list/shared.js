/**
 * Shared utilities for allow-list e2e tests
 *
 * This module provides:
 * - Mock fetch implementation with predefined responses
 * - Environment adapters for BashEnv and Sandbox
 * - Test utilities like expectBlocked
 */
import { expect, vi } from "vitest";
import { Bash } from "../../Bash.js";
import { Sandbox } from "../../sandbox/index.js";
// Unique markers in mock responses to verify we're not hitting real network
const MOCK_MARKER = "MOCK_RESPONSE_12345";
export const MOCK_SUCCESS_BODY = `{"message":"success","_mock":"${MOCK_MARKER}"}`;
export const MOCK_USERS_BODY = `{"users":[],"_mock":"${MOCK_MARKER}"}`;
export const MOCK_POSTS_BODY = `{"posts":[],"_mock":"${MOCK_MARKER}"}`;
export const MOCK_FILE_BODY = `file contents - ${MOCK_MARKER}`;
export const MOCK_EVIL_BODY = `EVIL DATA - should never see this - ${MOCK_MARKER}`;
// Mock responses for different URLs
const mockResponses = {
    "https://api.example.com/data": {
        status: 200,
        body: MOCK_SUCCESS_BODY,
        headers: { "content-type": "application/json" },
    },
    "https://api.example.com/v1/users": {
        status: 200,
        body: MOCK_USERS_BODY,
        headers: { "content-type": "application/json" },
    },
    "https://api.example.com/v1/posts": {
        status: 200,
        body: MOCK_POSTS_BODY,
        headers: { "content-type": "application/json" },
    },
    "https://api.example.com/v2/users": {
        status: 200,
        body: `{"v2":"users","_mock":"${MOCK_MARKER}"}`,
        headers: { "content-type": "application/json" },
    },
    "https://cdn.example.com/file.txt": {
        status: 200,
        body: MOCK_FILE_BODY,
        headers: { "content-type": "text/plain" },
    },
    "https://evil.com/data": {
        status: 200,
        body: MOCK_EVIL_BODY,
        headers: {},
    },
    "https://attacker.com/steal": {
        status: 200,
        body: `attacker data - ${MOCK_MARKER}`,
        headers: {},
    },
};
// Store original fetch
export const originalFetch = global.fetch;
// Mock fetch implementation
export function createMockFetch() {
    return vi.fn(async (url, _init) => {
        const urlString = typeof url === "string" ? url : url.toString();
        // Check for redirect behavior
        if (urlString === "https://api.example.com/redirect-to-evil") {
            return new Response("", {
                status: 302,
                headers: { location: "https://evil.com/data" },
            });
        }
        if (urlString === "https://api.example.com/redirect-to-allowed") {
            return new Response("", {
                status: 302,
                headers: { location: "https://api.example.com/data" },
            });
        }
        if (urlString === "https://api.example.com/redirect-chain") {
            return new Response("", {
                status: 302,
                headers: { location: "https://api.example.com/redirect-to-allowed" },
            });
        }
        const mockResponse = mockResponses[urlString];
        if (mockResponse) {
            const headers = new Headers(mockResponse.headers || {});
            return new Response(mockResponse.body, {
                status: mockResponse.status,
                statusText: mockResponse.status === 200 ? "OK" : "Error",
                headers,
            });
        }
        // Default: return 404
        return new Response("Not Found", { status: 404 });
    });
}
/**
 * Creates an adapter for BashEnv
 */
export function createBashEnvAdapter(options) {
    const env = new Bash(options);
    return {
        exec: (cmd) => env.exec(cmd),
        readFile: (path) => env.readFile(path),
    };
}
/**
 * Creates an adapter for Sandbox
 */
export async function createSandboxAdapter(options) {
    const sandbox = await Sandbox.create({ network: options.network });
    return {
        exec: async (cmd) => {
            const command = await sandbox.runCommand(cmd);
            const finished = await command.wait();
            return {
                exitCode: finished.exitCode,
                stdout: await command.stdout(),
                stderr: await command.stderr(),
            };
        },
        readFile: (path) => sandbox.readFile(path),
    };
}
/**
 * Utility for testing that a URL is blocked
 */
export async function expectBlocked(env, url, expectedUrl) {
    const result = await env.exec(`curl "${url}"`);
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("");
    // Verify the URL in the error message (may be normalized)
    const blockedUrl = expectedUrl ?? url;
    expect(result.stderr).toBe(`curl: (7) Network access denied: URL not in allow-list: ${blockedUrl}\n`);
}
/**
 * Utility for testing that a URL succeeds with expected mock response
 */
export async function expectAllowed(env, url, expectedBody) {
    const result = await env.exec(`curl "${url}"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(expectedBody);
    expect(result.stderr).toBe("");
}
