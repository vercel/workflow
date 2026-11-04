import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyLocalServerAccessible } from './health.js';

describe('verifyLocalServerAccessible', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
  });

  /** A server answering the health probe with `status` after `delayMs`. */
  async function healthServer(status: number, delayMs = 0) {
    const server = createServer((request, response) => {
      request.resume();
      setTimeout(() => response.writeHead(status).end(), delayMs);
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    return (server.address() as AddressInfo).port;
  }

  it('waits for a slow server for as long as the timeout allows', async () => {
    // A dev server compiling its flow route answers the first probe late.
    const port = await healthServer(200, 300);

    await expect(verifyLocalServerAccessible(false, port, 2_000)).resolves.toBe(
      `http://localhost:${port}`
    );
    await expect(verifyLocalServerAccessible(false, port, 50)).rejects.toThrow(
      /Cannot reach local server at http:\/\/localhost:\d+ \(.+\)/
    );
  });

  it('reports a server that answered with an error status as answering', async () => {
    const port = await healthServer(500);

    const error = await verifyLocalServerAccessible(false, port, 2_000).catch(
      (e: Error) => e
    );
    expect(String(error)).toContain(
      `The local server at http://localhost:${port} answered the workflow health check with HTTP 500`
    );
    expect(String(error)).not.toContain('--port');
  });
});
