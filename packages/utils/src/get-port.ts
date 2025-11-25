import { execa } from 'execa';

/**
 * Gets the port number that the process is listening on.
 * @returns The port number that the process is listening on, or undefined if the process is not listening on any port.
 */
export async function getPort(): Promise<number | undefined> {
  const { pid, platform } = process;

  let port: number | undefined;

  try {
    switch (platform) {
      case 'linux':
      case 'darwin': {
        const lsofResult = await execa('lsof', [
          '-a',
          '-i',
          '-P',
          '-n',
          '-p',
          pid.toString(),
        ]);
        const awkResult = await execa(
          'awk',
          ['/LISTEN/ {split($9,a,":"); print a[length(a)]; exit}'],
          {
            input: lsofResult.stdout,
          }
        );
        port = parseInt(awkResult.stdout.trim(), 10);
        break;
      }

      case 'win32': {
        // Use cmd to run the piped command
        const result = await execa('cmd', [
          '/c',
          `netstat -ano | findstr ${pid} | findstr LISTENING`,
        ]);

        const stdout = result.stdout.trim();

        if (stdout) {
          const lines = stdout.split('\n');
          for (const line of lines) {
            // Extract port from the local address column
            // Matches both IPv4 (e.g., "127.0.0.1:3000") and IPv6 bracket notation (e.g., "[::1]:3000")
            const match = line
              .trim()
              .match(/^\s*TCP\s+(?:\[[\da-f:]+\]|[\d.]+):(\d+)\s+/i);
            if (match) {
              port = parseInt(match[1], 10);
              break;
            }
          }
        }
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

  return Number.isNaN(port) ? undefined : port;
}
