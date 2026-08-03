function parsePort(value: string, radix = 10): number | undefined {
  const port = parseInt(value, radix);
  if (!Number.isNaN(port) && port >= 0 && port <= 65535) {
    return port;
  }
  return undefined;
}

export function parseWindowsNetstatPortsForPid(
  stdout: string,
  pid: number
): number[] {
  const ports: number[] = [];
  const lines = stdout.trim().split('\n');

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0]?.toUpperCase() !== 'TCP') {
      continue;
    }

    const [, localAddress, , state, rowPid] = parts;
    if (state?.toUpperCase() !== 'LISTENING' || rowPid !== pid.toString()) {
      continue;
    }

    const colonIndex = localAddress.lastIndexOf(':');
    if (colonIndex === -1) {
      continue;
    }

    const port = parsePort(localAddress.slice(colonIndex + 1));
    if (port !== undefined) {
      ports.push(port);
    }
  }

  return ports;
}
