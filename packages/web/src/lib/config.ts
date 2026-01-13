'use client';

/**
 * URL building utilities for navigation.
 *
 * World configuration is no longer managed via query params.
 * The web UI now uses server-side environment variables exclusively
 * (same as the workflow runtime's createWorld() behavior).
 *
 * These utilities only handle URL navigation (deep linking to runs, steps, etc.)
 */

/**
 * Helper to build a URL with navigation params.
 *
 * World config is no longer included in URLs - it comes from server env vars.
 * This function only handles navigation state (sidebar, selectedId, etc.)
 */
export function buildUrlWithConfig(
  path: string,
  additionalParams?: Record<string, string>
): string {
  const params = new URLSearchParams();

  // Add navigation params
  if (additionalParams) {
    for (const [key, value] of Object.entries(additionalParams)) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, value);
      }
    }
  }

  const search = params.toString();
  return search ? `${path}?${search}` : path;
}
