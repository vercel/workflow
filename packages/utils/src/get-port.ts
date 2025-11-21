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
        const result = { stdout: awkResult.stdout };
        port = parseInt(result.stdout.trim(), 10);
        break;
      }
      case 'win32': {
        const lsofResult = await execa('netstat', [
          '-a',
          '-n',
          '-o',
          pid.toString(),
        ]);
        const awkResult = await execa(
          'awk',
          [
            `pid=${pid}`,
            '/LISTENING/ && $NF == pid {split($2,a,\":\"); print a[length(a)]; exit}',
          ],
          {
            input: lsofResult.stdout,
          }
        );
        const result = { stdout: awkResult.stdout };
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

  return Number.isNaN(port) ? undefined : port;
}
