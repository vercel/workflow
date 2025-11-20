import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { pidToPorts } from 'pid-port';

const execAsync = promisify(exec);

/**
 * Gets the port number that the process is listening on.
 * @returns The port number that the process is listening on, or undefined if the process is not listening on any port.
 * NOTE: Can't move this to @workflow/utils because it's being imported into @workflow/errors for RetryableError (inside workflow runtime)
 */
export async function getPort(): Promise<number | undefined> {
  try {
    const ports = Array.from(await pidToPorts(process.pid));

    // pid-port failed to detect the server port
    if (ports.length === 0 || ports.length > 1) {
      const platform = process.platform;

      // Use our fallback
      switch (platform) {
        case 'linux':
        case 'darwin': {
          const result = await execAsync(
            `lsof -i -P -n | grep -w ${process.pid} | grep LISTEN | awk '{print $9}' | sed 's/.*://' | head -n 1`
          );
          const port = parseInt(result.stdout.trim(), 10);
          return Number.isNaN(port) ? undefined : port;
        }
        case 'win32':
          throw new Error('Not implemented');
      }

      return undefined;
    }

    // Server port most likely to be minimum
    return Math.min(...ports);
  } catch {
    return undefined;
  }
}
