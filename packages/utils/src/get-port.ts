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

  let ports: number[] = [];

  try {
    // Use our fallback
    switch (platform) {
      case 'linux':
      case 'darwin': {
        const result = await execAsync(
          `lsof -i -P -n | grep -w ${pid} | grep LISTEN | awk '{print $9}' | sed 's/.*://'`
        );
        ports = result.stdout
          .trim()
          .split('\n')
          .filter((line) => line.length > 0)
          .map((port) => parseInt(port, 10))
          .filter((port) => !Number.isNaN(port));
        break;
      }
      case 'win32': {
        const result = await execAsync(`netstat -ano`);
        const lines = result.stdout.trim().split('\n');

        for (const line of lines) {
          const parts = line.trim().split(/\s+/);

          if (
            parts.length >= 5 &&
            parts[3] === 'LISTENING' &&
            parts[4] === pid.toString()
          ) {
            const localAddress = parts[1];
            const portMatch = localAddress.match(/:(\d+)$/);

            if (portMatch && portMatch[1]) {
              ports.push(parseInt(portMatch[1], 10));
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

  // Return the lowest port number (usually first)
  ports.sort((a, b) => a - b);

  if (ports.length === 0 || Number.isNaN(ports[0])) {
    return undefined;
  }

  return ports[0];
}
