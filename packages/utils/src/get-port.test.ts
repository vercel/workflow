import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { getAllPorts, getPort, getWorkflowPort } from './get-port';

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

describe('getAllPorts', () => {
  let servers: http.Server[] = [];

  afterEach(() => {
    servers.forEach((server) => {
      server.close();
    });
    servers = [];
  });

  it('should return empty array when no ports are listening', async () => {
    const ports = await getAllPorts();
    expect(ports).toEqual([]);
  });

  it('should return all listening ports', async () => {
    const server1 = http.createServer();
    const server2 = http.createServer();
    servers.push(server1, server2);

    await new Promise<void>((resolve) => server1.listen(0, resolve));
    await new Promise<void>((resolve) => server2.listen(0, resolve));

    const ports = await getAllPorts();
    const addr1 = server1.address() as AddressInfo;
    const addr2 = server2.address() as AddressInfo;

    expect(ports).toContain(addr1.port);
    expect(ports).toContain(addr2.port);
    // On Windows, each server may report both IPv4 and IPv6, so we check >= 2
    expect(ports.length).toBeGreaterThanOrEqual(2);
  });

  it('should return ports in deterministic order', async () => {
    const server1 = http.createServer();
    const server2 = http.createServer();
    servers.push(server1, server2);

    await new Promise<void>((resolve) => server1.listen(0, resolve));
    await new Promise<void>((resolve) => server2.listen(0, resolve));

    // Call multiple times and verify order is consistent
    const ports1 = await getAllPorts();
    const ports2 = await getAllPorts();
    const ports3 = await getAllPorts();

    expect(ports1).toEqual(ports2);
    expect(ports2).toEqual(ports3);
  });
});

describe('getWorkflowPort', () => {
  let servers: http.Server[] = [];

  afterEach(() => {
    servers.forEach((server) => {
      server.close();
    });
    servers = [];
  });

  it('should return undefined when no ports are listening', async () => {
    const port = await getWorkflowPort();
    expect(port).toBeUndefined();
  });

  it('should return single port without probing', async () => {
    const server = http.createServer();
    servers.push(server);
    server.listen(0);

    const port = await getWorkflowPort();
    const addr = server.address() as AddressInfo;

    expect(port).toBe(addr.port);
  });

  it('should identify workflow server among multiple ports', async () => {
    // Non-workflow server (returns 404 for all requests)
    const nonWorkflowServer = http.createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });

    // Workflow server (returns 200 for health check endpoint)
    const workflowServer = http.createServer((req, res) => {
      if (req.url?.includes('__health')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Workflow DevKit endpoint is healthy');
      } else if (req.url?.startsWith('/.well-known/workflow/v1/')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required headers' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    servers.push(nonWorkflowServer, workflowServer);

    await new Promise<void>((resolve) => nonWorkflowServer.listen(0, resolve));
    await new Promise<void>((resolve) => workflowServer.listen(0, resolve));

    const port = await getWorkflowPort();
    const workflowAddr = workflowServer.address() as AddressInfo;

    expect(port).toBe(workflowAddr.port);
  });

  it('should fall back to first port when probing fails', async () => {
    // Two non-workflow servers (both return 404)
    const server1 = http.createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    const server2 = http.createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });

    servers.push(server1, server2);
    await new Promise<void>((resolve) => server1.listen(0, resolve));
    await new Promise<void>((resolve) => server2.listen(0, resolve));

    const port = await getWorkflowPort();
    const addr1 = server1.address() as AddressInfo;

    // Should fall back to first port
    expect(port).toBe(addr1.port);
  });

  it('should respect custom timeout', async () => {
    // Slow server that doesn't respond in time
    const slowServer = http.createServer(() => {
      // Never respond
    });
    // Fast workflow server (returns 200 for health check)
    const fastServer = http.createServer((req, res) => {
      if (req.url?.includes('__health')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Workflow DevKit endpoint is healthy');
      } else if (req.url?.startsWith('/.well-known/workflow/v1/')) {
        res.writeHead(400);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    servers.push(slowServer, fastServer);
    await new Promise<void>((resolve) => slowServer.listen(0, resolve));
    await new Promise<void>((resolve) => fastServer.listen(0, resolve));

    const start = Date.now();
    const port = await getWorkflowPort({ timeout: 100 });
    const elapsed = Date.now() - start;

    const fastAddr = fastServer.address() as AddressInfo;
    expect(port).toBe(fastAddr.port);
    // Should complete reasonably quickly (Windows CI can be slow)
    expect(elapsed).toBeLessThan(2000);
  });

  it('should handle concurrent getWorkflowPort calls', async () => {
    const server = http.createServer((req, res) => {
      if (req.url?.includes('__health')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Workflow DevKit endpoint is healthy');
      } else if (req.url?.startsWith('/.well-known/workflow/v1/')) {
        res.writeHead(400);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const addr = server.address() as AddressInfo;

    // Call getWorkflowPort concurrently 5 times
    const results = await Promise.all(
      Array(5)
        .fill(0)
        .map(() => getWorkflowPort())
    );

    // All should return the same port
    results.forEach((port) => {
      expect(port).toBe(addr.port);
    });
  });
});
