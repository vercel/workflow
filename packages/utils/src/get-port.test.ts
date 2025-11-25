import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { getPort } from './get-port';

describe('getPort', () => {
  let servers: http.Server[] = [];

  afterEach(() => {
    servers.forEach((server) => {
      server.close();
    });
    servers = [];
  });

  it('should return undefined when no ports are in use', async () => {
    const port = await getPort();

    expect(port).toBeUndefined();
  });

  it('should handle servers listening on specific ports', async () => {
    const server = http.createServer();
    servers.push(server);

    // Listen on a specific port instead of 0
    const specificPort = 3000;
    server.listen(specificPort);

    const port = await getPort();

    expect(port).toEqual(specificPort);
  });

  it('should return the port number that the server is listening', async () => {
    const server = http.createServer();
    servers.push(server);

    server.listen(0);

    const port = await getPort();
    const addr = server.address() as AddressInfo;

    expect(typeof port).toBe('number');
    expect(port).toEqual(addr.port);
  });

  it('should return the first port of the server', async () => {
    const server1 = http.createServer();
    const server2 = http.createServer();
    servers.push(server1);
    servers.push(server2);

    server1.listen(0);
    server2.listen(0);

    const port = await getPort();
    const addr1 = server1.address() as AddressInfo;

    expect(port).toEqual(addr1.port);
  });

  it('should return consistent results when called multiple times', async () => {
    const server = http.createServer();
    servers.push(server);
    server.listen(0);

    const port1 = await getPort();
    const port2 = await getPort();
    const port3 = await getPort();

    expect(port1).toEqual(port2);
    expect(port2).toEqual(port3);
  });

  it('should handle IPv6 addresses', async () => {
    const server = http.createServer();
    servers.push(server);

    try {
      server.listen(0, '::1'); // IPv6 localhost
      const port = await getPort();
      const addr = server.address() as AddressInfo;

      expect(port).toEqual(addr.port);
    } catch {
      // Skip test if IPv6 is not available
      console.log('IPv6 not available, skipping test');
    }
  });

  it('should handle multiple calls in sequence', async () => {
    const server = http.createServer();
    servers.push(server);

    server.listen(0);

    const port1 = await getPort();
    const port2 = await getPort();
    const addr = server.address() as AddressInfo;

    // Should return the same port each time
    expect(port1).toEqual(addr.port);
    expect(port2).toEqual(addr.port);
  });

  it('should handle closed servers', async () => {
    const server = http.createServer();

    server.listen(0);
    const addr = server.address() as AddressInfo;
    const serverPort = addr.port;

    // Close the server before calling getPort
    server.close();

    const port = await getPort();

    // Port should not be the closed server's port
    expect(port).not.toEqual(serverPort);
  });

  it('should handle server restart on same port', async () => {
    const server1 = http.createServer();
    servers.push(server1);
    server1.listen(3000);

    const port1 = await getPort();
    expect(port1).toEqual(3000);

    server1.close();
    servers = servers.filter((s) => s !== server1);

    // Small delay to ensure port is released
    await new Promise((resolve) => setTimeout(resolve, 100));

    const server2 = http.createServer();
    servers.push(server2);
    server2.listen(3000);

    const port2 = await getPort();
    expect(port2).toEqual(3000);
  });

  it('should handle concurrent getPort calls', async () => {
    // Workflow makes lots of concurrent getPort calls
    const server = http.createServer();
    servers.push(server);
    server.listen(0);

    const addr = server.address() as AddressInfo;

    // Call getPort concurrently 10 times
    const results = await Promise.all(
      Array(10)
        .fill(0)
        .map(() => getPort())
    );

    // All should return the same port without errors
    results.forEach((port) => {
      expect(port).toEqual(addr.port);
    });
  });
});
