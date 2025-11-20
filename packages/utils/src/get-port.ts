import { pidToPorts } from 'pid-port';

/**
 * Gets the port number that the process is listening on.
 * @returns The port number that the process is listening on, or undefined if the process is not listening on any port.
 * NOTE: Can't move this to @workflow/utils because it's being imported into @workflow/errors for RetryableError (inside workflow runtime)
 */
export async function getPort(): Promise<number | undefined> {
  try {
    const pid = process.pid;
    const ports = await pidToPorts(pid);
    if (!ports || ports.size === 0) {
      return undefined;
    }

    const smallest = Math.min(...ports);
    return smallest;
  } catch {
    // If port detection fails (e.g., `ss` command not available in production),
    // return undefined and fall back to default port
    return undefined;
  }
}
