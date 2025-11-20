import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Gets the port number that the process is listening on.
 * @returns The port number that the process is listening on, or undefined if the process is not listening on any port.
 * NOTE: Can't move this to @workflow/utils because it's being imported into @workflow/errors for RetryableError (inside workflow runtime)
 */
export async function getPort(): Promise<number | undefined> {
  const pid = process.pid;
  const platform = process.platform;

  let port: number | undefined;

  try {
    // Use our fallback
    switch (platform) {
      case 'linux':
      case 'darwin': {
        const result = await execAsync(
          `lsof -i -P -n | grep -w ${pid} | grep LISTEN | awk '{print $9}' | sed 's/.*://' | head -n 1`
        );
        port = parseInt(result.stdout.trim(), 10);
        break;
      }
      case 'win32': {
        const result = await execAsync('netstat -ano');
        const lines = result.stdout.trim().split('\n');

        for (const line of lines) {
          // Windows netstat format: TCP    0.0.0.0:8080    0.0.0.0:0    LISTENING    1234
          const parts = line.trim().split(/\s+/);

          if (
            parts.length >= 5 &&
            parts[3] === 'LISTENING' &&
            parts[4] === pid.toString()
          ) {
            // Extract port from the local address (e.g., "0.0.0.0:8080")
            const localAddress = parts[1];
            const portMatch = localAddress.match(/:(\d+)$/);

            if (portMatch && portMatch[1]) {
              port = parseInt(portMatch[1], 10);
              break;
            }
          }
        }
        break;
      }
    }
  } catch {
    // Unavailable (e.g. Serverless environments)
    return undefined;
  }

  return Number.isNaN(port) ? undefined : port;
}
