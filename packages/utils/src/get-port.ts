import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Gets the port number that the process is listening on.
 * @returns The port number that the process is listening on, or undefined if the process is not listening on any port.
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
        // Grab the first port entry reported
        const result = await execAsync(
          `lsof -i -P -n | grep -w ${pid} | grep LISTEN | awk '{print $9}' | sed 's/.*://' | head -n 1`
        );
        port = parseInt(result.stdout.trim(), 10);
        break;
      }
      case 'win32': {
        const result = await execAsync(`netstat -ano`);
        const lines = result.stdout.trim().split('\n');
        const ports: number[] = [];

        for (const line of lines) {
          const parts = line.trim().split(/\s+/);

          if (
            parts.length >= 5 &&
            parts[3] === 'LISTENING' &&
            parts[4] === pid.toString()
          ) {
            const localAddress = parts[1];
            const portMatch = localAddress.match(/:(\d+)$/);

            if (portMatch?.[1]) {
              const foundPort = parseInt(portMatch[1], 10);
              if (!Number.isNaN(foundPort)) {
                ports.push(foundPort);
              }
            }
          }
        }

        // Return the lowest port for consistency
        if (ports.length > 0) {
          port = Math.min(...ports);
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
