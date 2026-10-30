import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame } from './frames.js';
import { REQUEST_TIMEOUT_MS } from './http-core.js';
import {
  getWsEventsTransport,
  resetWsEventsTransportsForTest,
} from './ws-transport.js';

const eventFrame = (reqId: number) =>
  encodeFrame(
    { reqId, type: 'event', event: { eventType: 'run_created' } },
    new Uint8Array(0)
  );

const headers = async () => ({ authorization: 'Bearer token-1' });

describe('a server that accepts the upgrade and never answers it', () => {
  let server: Server;
  let wsUrl: string;
  let upgrades: Socket[];

  beforeEach(async () => {
    upgrades = [];
    server = createServer((_req, res) => res.writeHead(503).end());
    server.on('upgrade', (_req, socket: Socket) => {
      upgrades.push(socket);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const { port } = server.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${port}/websockets/v1/runs/wrun_1`;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetWsEventsTransportsForTest();
    server.closeAllConnections();
    for (const socket of upgrades) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const upgradeReceived = async () => {
    while (upgrades.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return upgrades[0];
  };

  it('fails the waiting write, drops the socket, and closes the channel', async () => {
    const transport = getWsEventsTransport(wsUrl, headers);
    transport.open();
    let outcome: unknown = 'pending';
    const write = transport.request(eventFrame).then(
      () => 'resolved',
      (err: Error) => err
    );
    void write.then((value) => {
      outcome = value;
    });
    const socket = await upgradeReceived();
    const socketEnded = new Promise((resolve) => socket.once('end', resolve));

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    await socketEnded;
    await write;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/handshake .* timed out/);
    expect(getWsEventsTransport(wsUrl, headers)).not.toBe(transport);
    expect(upgrades).toHaveLength(1);
  });
});
