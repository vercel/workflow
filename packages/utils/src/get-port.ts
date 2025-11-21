import { exec, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Gets the port number that the process is listening on.
 * @returns The port number that the process is listening on, or undefined if the process is not listening on any port.
 */
export async function getPort(): Promise<number | undefined> {
  const { pid, platform } = process;

  let port: number | undefined;

  try {
    // Use our fallback
    switch (platform) {
      case 'linux':
      case 'darwin': {
        const lsofResult = execFileSync(
          'lsof',
          ['-a', '-i', '-P', '-n', '-p', pid.toString()],
          {
            encoding: 'utf-8',
          }
        );
        const awkResult = execFileSync(
          'awk',
          ['/LISTEN/ {split($9,a,":"); print a[length(a)]; exit}'],
          {
            encoding: 'utf-8',
            input: lsofResult,
          }
        );
        const result = { stdout: awkResult };
        port = parseInt(result.stdout.trim(), 10);
        break;
      }
      case 'win32': {
        const lsofResult = execFileSync(
          'netstat',
          ['-a', '-n', '-o', pid.toString()],
          {
            encoding: 'utf-8',
          }
        );
        const awkResult = execFileSync(
          'awk',
          [
            '/LISTENING/ && /${pid}/ {split($2,a,\":\"); print a[length(a)]; exit}',
          ],
          {
            encoding: 'utf-8',
            input: lsofResult,
          }
        );
        const result = { stdout: awkResult };
        port = parseInt(result.stdout.trim(), 10);
        break;
      }
    }
  } catch (error) {
    // In dev, it's helpful to know why detection failed
    if (process.env.NODE_ENV === 'development') {
      console.debug('[getPort] Detection failed:', error);
    }
    return undefined;
  }

  return port || undefined;
}
