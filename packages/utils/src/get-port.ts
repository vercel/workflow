import { pidToPorts } from 'pid-port';

let port: number | undefined;
const seenPorts: Set<number> = new Set();

/**
 * Gets the port number that the process is listening on.
 * @returns The port number that the process is listening on, or undefined if the process is not listening on any port.
 * NOTE: Can't move this to @workflow/utils because it's being imported into @workflow/errors for RetryableError (inside workflow runtime)
 */
export async function getPort(): Promise<number | undefined> {
  // Validate cached port is still listening before returning it
  if (port) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 100);

      try {
        await fetch(`http://localhost:${port}`, {
          signal: controller.signal,
        });

        // Port is still valid
        return port;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      // Cached port is no longer listening, clear it and rediscover
      port = undefined;
      seenPorts.clear();
    }
  }

  try {
    const pid = process.pid;

    const ports = await pidToPorts(pid);
    if (!ports || ports.size === 0) {
      return undefined;
    }

    // Try each port we haven't already seen
    const portArray = Array.from(ports)
      .sort((a, b) => a - b)
      .filter((p) => !seenPorts.has(p));

    if (portArray.length === 0) {
      // All ports have been tried and failed
      return undefined;
    }

    for (const testPort of portArray) {
      try {
        // Add timeout to prevent hanging on non-HTTP ports
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 100);

        try {
          await fetch(`http://localhost:${testPort}`, {
            signal: controller.signal,
          });

          // If fetch succeeds, cache and return the port
          port = testPort;
          return port;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        seenPorts.add(testPort);
        // Continue to next port
      }
    }
  } catch {}

  return undefined;
}
