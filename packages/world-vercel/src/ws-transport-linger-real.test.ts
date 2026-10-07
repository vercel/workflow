/**
 * Linger against the real `ws` package and a real local server, because it
 * leans on two things the fakes elsewhere can only assume:
 *
 *  - `ws` keeps its raw socket on the private `_socket`, so the transport can
 *    unref a lingering socket (and must, or an idle socket holds the process),
 *  - the server's automatic pong echoes the ping payload, which is what a
 *    reclaimed socket is verified by.
 *
 * If a `ws` upgrade renames `_socket`, the first test here fails rather than
 * linger silently turning into close-on-release (or, worse, a ref'd socket).
 */

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import {
  getWsEventsTransport,
  resetWsEventsTransportsForTest,
} from './ws-transport.js';

let server: WebSocketServer;
let serverSockets: WsServerSocket[];
let wsUrl: string;

/** Handles currently keeping the event loop alive, by type. */
const activeTcp = () =>
  process.getActiveResourcesInfo().filter((type) => type === 'TCPSocketWrap')
    .length;

beforeEach(async () => {
  serverSockets = [];
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  server.on('connection', (socket) => serverSockets.push(socket));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${port}/api/websockets/v1/runs/wrun_real`;
  resetWsEventsTransportsForTest();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  resetWsEventsTransportsForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const socket of serverSockets) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const headers = async () => ({ authorization: 'Bearer test' });

async function openLive() {
  const transport = getWsEventsTransport(wsUrl, headers);
  transport.open();
  await vi.waitFor(() => expect(transport.notReadyReason()).toBeNull());
  return transport;
}

describe('linger over a real ws socket', () => {
  it('unrefs the socket while it lingers and refs it again on reclaim', async () => {
    const transport = await openLive();
    const whileClaimed = activeTcp();

    transport.release('first invocation complete');
    expect(transport.lingering).toBe(true);
    // The client socket stopped holding the loop; the server's half (same
    // process here) still does.
    expect(activeTcp()).toBe(whileClaimed - 1);

    transport.open();
    expect(activeTcp()).toBe(whileClaimed);
    expect(transport.notReadyReason()).toBe('verifying');
    // The server's `ws` answers the ping with the same payload.
    await vi.waitFor(() => expect(transport.notReadyReason()).toBeNull());
    expect(transport.connectionReused).toBe(true);
    expect(serverSockets).toHaveLength(1);
  });

  it('closes cleanly at the end of the window', async () => {
    vi.stubEnv('WORKFLOW_EVENTS_TRANSPORT_WS_LINGER_MS', '30');
    const transport = await openLive();
    const closed = new Promise<number>((resolve) =>
      serverSockets[0]?.once('close', resolve)
    );

    transport.release('invocation complete');

    await expect(closed).resolves.toBe(1000);
    expect(transport.lingering).toBe(false);
  });

  it('ends the linger when the server closes the socket', async () => {
    const transport = await openLive();
    transport.release('invocation complete');

    serverSockets[0]?.close(1001, 'drain');

    await vi.waitFor(() => expect(transport.lingering).toBe(false));
    expect(getWsEventsTransport(wsUrl, headers)).not.toBe(transport);
    // No reconnect for a channel nobody holds.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(serverSockets).toHaveLength(1);
  });
});
