/**
 * Node.js-only utilities
 *
 * These utilities require Node.js APIs and cannot be used in the workflow runtime VM.
 * Import from '@workflow/utils/node' to use these functions.
 */

import { pidToPorts } from 'pid-port';

/**
 * Gets the port number that the current Node.js process is listening on.
 *
 * Uses process introspection to detect which port the application is using.
 * This is useful for frameworks that use non-standard ports (SvelteKit, Vite, etc.)
 *
 * @returns The smallest port number the process is listening on, or undefined if not listening on any port
 *
 * @example
 * ```typescript
 * const port = await getPort();
 * if (port) {
 *   console.log(`Server is listening on port ${port}`);
 * }
 * ```
 */
export async function getPort(): Promise<number | undefined> {
  try {
    const pid = process.pid;
    const ports = await pidToPorts(pid);

    if (!ports || ports.size === 0) {
      return undefined;
    }

    // Return the smallest port number
    const smallest = Math.min(...ports);
    return smallest;
  } catch {
    // If port detection fails (e.g., `ss` command not available in production),
    // return undefined and fall back to default port
    return undefined;
  }
}
