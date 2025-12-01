import { readdir, readFile, readlink } from 'node:fs/promises';
import { execa } from 'execa';

/**
 * Parses a port string and returns it if valid (0-65535), otherwise undefined.
 */
function parsePort(value: string, radix = 10): number | undefined {
  const port = parseInt(value, radix);
  if (!Number.isNaN(port) && port >= 0 && port <= 65535) {
    return port;
  }
  return undefined;
}

// NOTE: We build /proc paths dynamically to prevent @vercel/nft from tracing them.
// NFT's static analysis tries to bundle any file path literal it finds (e.g., '/proc/net/tcp').
// Since /proc is a virtual Linux filesystem, this causes build failures in @sveltejs/adapter-vercel.
const join = (arr: string[], sep: string) => arr.join(sep);
const PROC_ROOT = join(['', 'proc'], '/');

/**
 * Gets listening ports for the current process on Linux by reading /proc filesystem.
 * This approach requires no external commands and works on all Linux systems.
 */
async function getLinuxPort(pid: number): Promise<number | undefined> {
  const listenState = '0A'; // TCP LISTEN state in /proc/net/tcp
  const tcpFiles = [`${PROC_ROOT}/net/tcp`, `${PROC_ROOT}/net/tcp6`] as const;

  // Step 1: Get socket inodes from /proc/<pid>/fd/ in order
  // We preserve order to maintain deterministic behavior (return first port)
  // Use both array (for order) and Set (for O(1) lookup)
  const socketInodes: string[] = [];
  const socketInodesSet = new Set<string>();
  const fdPath = `${PROC_ROOT}/${pid}/fd`;

  try {
    const fds = await readdir(fdPath);
    // Sort FDs numerically to ensure deterministic order (FDs are always numeric strings)
    const sortedFds = fds.sort((a, b) => {
      const numA = Number.parseInt(a, 10);
      const numB = Number.parseInt(b, 10);
      return numA - numB;
    });

    const results = await Promise.allSettled(
      sortedFds.map(async (fd) => {
        const link = await readlink(`${fdPath}/${fd}`);
        // Socket links look like: socket:[12345]
        const match = link.match(/^socket:\[(\d+)\]$/);
        return match?.[1] ?? null;
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        socketInodes.push(result.value);
        socketInodesSet.add(result.value);
      }
    }
  } catch {
    // Process might not exist or no permission
    return undefined;
  }

  if (socketInodes.length === 0) {
    return undefined;
  }

  // Step 2: Read /proc/net/tcp and /proc/net/tcp6 to find listening sockets
  // Format: sl local_address rem_address st ... inode
  // local_address is hex IP:port, st=0A means LISTEN
  // We iterate through socket inodes in order to maintain deterministic behavior
  for (const tcpFile of tcpFiles) {
    try {
      const content = await readFile(tcpFile, 'utf8');
      const lines = content.split('\n').slice(1); // Skip header

      // Build a map of inode -> port for quick lookup
      const inodeToPort = new Map<string, number>();
      for (const line of lines) {
        if (!line.trim()) continue; // Skip empty lines

        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) continue;

        const localAddr = parts[1]; // e.g., "00000000:0BB8" (0.0.0.0:3000)
        const state = parts[3]; // "0A" = LISTEN
        const inode = parts[9];

        if (!localAddr || state !== listenState || !inode) continue;
        if (!socketInodesSet.has(inode)) continue;

        // Extract port from hex format (e.g., "0BB8" -> 3000)
        const colonIndex = localAddr.indexOf(':');
        if (colonIndex === -1) continue;

        const portHex = localAddr.slice(colonIndex + 1);
        if (!portHex) continue;

        const port = parsePort(portHex, 16);
        if (port !== undefined) {
          inodeToPort.set(inode, port);
        }
      }

      // Return the first port matching our socket inodes in order
      for (const inode of socketInodes) {
        const port = inodeToPort.get(inode);
        if (port !== undefined) {
          return port;
        }
      }
    } catch {
      // File might not exist (e.g., no IPv6 support) - continue to next file
      continue;
    }
  }

  return undefined;
}

/**
 * Gets the port number that the process is listening on.
 * @returns The port number that the process is listening on, or undefined if the process is not listening on any port.
 */
export async function getPort(): Promise<number | undefined> {
  const { pid, platform } = process;

  let port: number | undefined;

  try {
    switch (platform) {
      case 'linux': {
        port = await getLinuxPort(pid);
        break;
      }
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
        port = parsePort(awkResult.stdout.trim());
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
              port = parsePort(match[1]);
              if (port !== undefined) {
                break;
              }
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
