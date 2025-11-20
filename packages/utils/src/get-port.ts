import { pidToPorts } from 'pid-port';
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

  console.log(await pidToPorts(pid));

  let port: number | undefined;
  switch (platform) {
    case 'linux':
    case 'darwin': {
      try {
        const result = await execAsync(
          `lsof -i -P -n | grep -w ${pid} | grep LISTEN | awk '{print $9}' | sed 's/.*://' | head -n 1`
        );
        port = parseInt(result.stdout.trim(), 10);
        console.log(port);
      } catch {
        // Port detection may fail in some environments (e.g., serverless)
        return undefined;
      }
      break;
    }
    case 'win32':
      throw new Error('Not implemented');
  }

  if (!port || Number.isNaN(port)) {
    return undefined;
  }

  return port;
}
