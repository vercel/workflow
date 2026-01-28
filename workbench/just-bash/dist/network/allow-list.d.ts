/**
 * URL allow-list matching
 *
 * This module provides URL allow-list matching that is enforced at the fetch layer,
 * independent of any parsing or user input manipulation.
 */
/**
 * Parses a URL string into its components.
 * Returns null if the URL is invalid.
 */
export declare function parseUrl(urlString: string): {
    origin: string;
    pathname: string;
    href: string;
} | null;
/**
 * Normalizes an allow-list entry for consistent matching.
 * - Removes trailing slashes from origins without paths
 * - Preserves path prefixes as-is
 */
export declare function normalizeAllowListEntry(entry: string): {
    origin: string;
    pathPrefix: string;
} | null;
/**
 * Checks if a URL matches an allow-list entry.
 *
 * The matching rules are:
 * 1. Origins must match exactly (case-sensitive for scheme and host)
 * 2. The URL's path must start with the allow-list entry's path
 * 3. If the allow-list entry has no path (or just "/"), all paths are allowed
 *
 * @param url The URL to check (as a string)
 * @param allowedEntry The allow-list entry to match against
 * @returns true if the URL matches the allow-list entry
 */
export declare function matchesAllowListEntry(url: string, allowedEntry: string): boolean;
/**
 * Checks if a URL is allowed by any entry in the allow-list.
 *
 * @param url The URL to check
 * @param allowedUrlPrefixes The list of allowed URL prefixes
 * @returns true if the URL is allowed
 */
export declare function isUrlAllowed(url: string, allowedUrlPrefixes: string[]): boolean;
/**
 * Validates an allow-list configuration.
 * Each entry must be a full origin (scheme + host), optionally followed by a path prefix.
 * Returns an array of error messages for invalid entries.
 */
export declare function validateAllowList(allowedUrlPrefixes: string[]): string[];
