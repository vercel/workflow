import { readdir, readFile, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

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
 * Gets ALL listening ports for the current process on Linux by reading /proc filesystem.
 * Returns ports in order of file descriptor (deterministic ordering).
 */
async function getLinuxPorts(pid: number): Promise<number[]> {
  const listenState = '0A'; // TCP LISTEN state in /proc/net/tcp
  const tcpFiles = [`${PROC_ROOT}/net/tcp`, `${PROC_ROOT}/net/tcp6`] as const;

  // Step 1: Get socket inodes from /proc/<pid>/fd/ in order
  // We preserve order to maintain deterministic behavior
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
    return [];
  }

  if (socketInodes.length === 0) {
    return [];
  }

  // Step 2: Read /proc/net/tcp and /proc/net/tcp6 to find listening sockets
  // Format: sl local_address rem_address st ... inode
  // local_address is hex IP:port, st=0A means LISTEN
  const inodeToPort = new Map<string, number>();

  for (const tcpFile of tcpFiles) {
    try {
      const content = await readFile(tcpFile, 'utf8');
      const lines = content.split('\n').slice(1); // Skip header

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
    } catch {
      // File might not exist (e.g., no IPv6 support) - continue to next file
      continue;
    }
  }

  // Return all ports in socket inode order (deterministic)
  const ports: number[] = [];
  for (const inode of socketInodes) {
    const port = inodeToPort.get(inode);
    if (port !== undefined) {
      ports.push(port);
    }
  }

  return ports;
}

/**
 * Gets ALL listening ports for the current process on macOS using lsof.
 * Returns ports in the order they appear in lsof output.
 */
async function getDarwinPorts(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('lsof', [
      '-a',
      '-i',
      '-P',
      '-n',
      '-p',
      pid.toString(),
    ]);

    const ports: number[] = [];
    const lines = stdout.split('\n');

    for (const line of lines) {
      if (line.includes('LISTEN')) {
        // Column 9 (0-indexed: 8) contains the address like "*:3000" or "127.0.0.1:3000"
        const parts = line.trim().split(/\s+/);
        const addr = parts[8];
        if (addr) {
          const colonIndex = addr.lastIndexOf(':');
          if (colonIndex !== -1) {
            const port = parsePort(addr.slice(colonIndex + 1));
            if (port !== undefined) {
              ports.push(port);
            }
          }
        }
      }
    }

    return ports;
  } catch {
    return [];
  }
}

/**
 * Gets ALL listening ports for the current process on Windows using netstat.
 * Returns ports in the order they appear in netstat output.
 */
async function getWindowsPorts(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('cmd', [
      '/c',
      `netstat -ano | findstr ${pid} | findstr LISTENING`,
    ]);

    const ports: number[] = [];
    const trimmedOutput = stdout.trim();

    if (trimmedOutput) {
      const lines = trimmedOutput.split('\n');
      for (const line of lines) {
        // Extract port from the local address column
        // Matches both IPv4 (e.g., "127.0.0.1:3000") and IPv6 bracket notation (e.g., "[::1]:3000")
        const match = line
          .trim()
          .match(/^\s*TCP\s+(?:\[[\da-f:]+\]|[\d.]+):(\d+)\s+/i);
        if (match) {
          const port = parsePort(match[1]);
          if (port !== undefined) {
            ports.push(port);
          }
        }
      }
    }

    return ports;
  } catch {
    return [];
  }
}

/**
 * Gets all listening ports for the current process.
 * @returns Array of port numbers the process is listening on, in deterministic order.
 */
export async function getAllPorts(): Promise<number[]> {
  const { pid, platform } = process;

  try {
    switch (platform) {
      case 'linux':
        return await getLinuxPorts(pid);
      case 'darwin':
        return await getDarwinPorts(pid);
      case 'win32':
        return await getWindowsPorts(pid);
      default:
        return [];
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.debug('[getAllPorts] Detection failed:', error);
    }
    return [];
  }
}

/**
 * Gets the port number that the process is listening on.
 * @returns The port number that the process is listening on, or undefined if the process is not listening on any port.
 */
export async function getPort(): Promise<number | undefined> {
  const ports = await getAllPorts();
  return ports[0];
}

// Configuration for HTTP probing
const PROBE_TIMEOUT_MS = 500;
const PROBE_ENDPOINT = '/.well-known/workflow/v1/flow?__health';

export interface ProbeOptions {
  endpoint?: string;
  timeout?: number;
}

/**
 * Probes a port to check if it's serving the workflow HTTP server.
 * Uses HEAD request to minimize overhead.
 *
 * @returns true if the port responds with a 200 status from the health check endpoint
 */
async function probePort(
  port: number,
  options: ProbeOptions = {}
): Promise<boolean> {
  const { endpoint = PROBE_ENDPOINT, timeout = PROBE_TIMEOUT_MS } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`http://localhost:${port}${endpoint}`, {
      method: 'HEAD',
      signal: controller.signal,
    });

    // The workflow health endpoint returns 200 for healthy
    return response.status === 200;
  } catch {
    // Connection refused, timeout, or other error
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Gets the workflow server port by probing all listening ports.
 * This is more reliable than getPort() when other services (like Node.js inspector)
 * may also be listening on ports.
 *
 * @param options - Optional configuration for probing
 * @returns The port number of the workflow server, or undefined if not found
 */
export async function getWorkflowPort(
  options?: ProbeOptions
): Promise<number | undefined> {
  const ports = await getAllPorts();

  if (ports.length === 0) {
    return undefined;
  }

  if (ports.length === 1) {
    // Only one port, no need to probe
    return ports[0];
  }

  // Probe all ports in parallel
  const probeResults = await Promise.all(
    ports.map(async (port) => ({
      port,
      isWorkflow: await probePort(port, options),
    }))
  );

  // Return first port that responded as workflow server
  const workflowPort = probeResults.find((r) => r.isWorkflow);
  if (workflowPort) {
    return workflowPort.port;
  }

  // Fallback to first port if probing doesn't identify workflow server
  // This handles cases where:
  // - Server hasn't started workflow routes yet
  // - Network issues during probing
  if (process.env.NODE_ENV === 'development') {
    console.debug(
      '[getWorkflowPort] Probing failed, falling back to first port:',
      ports[0]
    );
  }
  return ports[0];
}
