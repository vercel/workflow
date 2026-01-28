/**
 * Secure fetch wrapper with allow-list enforcement
 *
 * This module provides a fetch wrapper that:
 * 1. Enforces URL allow-list at the fetch layer (not subject to parsing)
 * 2. Handles redirects manually to check each redirect target against the allow-list
 * 3. Provides timeout support
 */
import { type FetchResult, type NetworkConfig } from "./types.js";
export interface SecureFetchOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    followRedirects?: boolean;
    /** Override timeout for this request (capped at global timeout) */
    timeoutMs?: number;
}
/**
 * Type for the secure fetch function
 */
export type SecureFetch = (url: string, options?: SecureFetchOptions) => Promise<FetchResult>;
/**
 * Creates a secure fetch function that enforces the allow-list.
 */
export declare function createSecureFetch(config: NetworkConfig): SecureFetch;
