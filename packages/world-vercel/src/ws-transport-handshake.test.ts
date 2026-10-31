import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { encode } from 'cbor-x';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { withEventPostRetry } from './event-retry.js';
import { createWorkflowRunEventV4 } from './events-v4.js';
import { encodeFrame } from './frames.js';
import { REQUEST_TIMEOUT_MS } from './http-core.js';
import {
  getWsEventsTransport,
  openWsChannel,
  resetWsEventsTransportsForTest,
  resolveWsTransport,
} from './ws-transport.js';

vi.mock('./get-deadline.js', () => ({
  getDeadline: vi.fn(async () => undefined),
}));

const CREATED_AT = '2026-06-10T00:00:00.000Z';
const config = { token: 'test-token' };

const eventFrame = (reqId: number) =>
  encodeFrame(
    { reqId, type: 'event', event: { eventType: 'run_created' } },
    new Uint8Array(0)
  );

const stepCompletedReply = () =>
  encode({
    event: {
      eventType: 'step_completed',
      specVersion: 2,
      correlationId: 'step_1',
      eventData: { result: new Uint8Array() },
      eventId: 'evnt_1',
      runId: 'wrun_1',
      createdAt: CREATED_AT,
    },
    step: {
      runId: 'wrun_1',
      stepId: 'step_1',
      stepName: 'step',
      status: 'completed',
      attempt: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  });

const writeStepCompleted = () =>
  withEventPostRetry(
    () =>
      createWorkflowRunEventV4(
        {
          runId: 'wrun_1',
          eventType: 'step_completed',
          specVersion: 2,
          correlationId: 'step_1',
          payload: new TextEncoder().encode('"result"'),
        },
        config
      ),
    'step_completed'
  );

describe.each([
  ['never answers the upgrade', 'hang'],
  ['accepts the upgrade and never answers a frame', 'silent'],
] as const)('a server that %s', (_case, mode) => {
  let server: Server;
  let wss: WebSocketServer;
  let upgrades: Socket[];
  let posts: number;

  beforeEach(async () => {
    upgrades = [];
    posts = 0;
    wss = new WebSocketServer({ noServer: true });
    server = createServer((req, res) => {
      if (req.method !== 'POST') return res.writeHead(404).end();
      posts++;
      req.resume();
      res
        .writeHead(200, {
          'x-wf-event-id': 'evnt_1',
          'x-wf-run-id': 'wrun_1',
          'x-wf-created-at': CREATED_AT,
        })
        .end(stepCompletedReply());
    });
    server.on('upgrade', (req, socket: Socket, head) => {
      upgrades.push(socket);
      if (mode === 'silent') wss.handleUpgrade(req, socket, head, () => {});
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const { port } = server.address() as AddressInfo;
    process.env.VERCEL_WORKFLOW_SERVER_URL = `http://127.0.0.1:${port}/api`;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.VERCEL_WORKFLOW_SERVER_URL;
    resetWsEventsTransportsForTest();
    for (const client of wss.clients) client.terminate();
    for (const socket of upgrades) socket.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const settle = async <T>(promise: Promise<T>): Promise<T> => {
    let done = false;
    void promise.finally(() => {
      done = true;
    });
    for (let i = 0; !done && i < 200; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return promise;
  };

  it('completes the write over HTTP and keeps later writes there', async () => {
    openWsChannel('wrun_1', config);

    const first = await settle(writeStepCompleted());

    expect(first.step).toMatchObject({ stepId: 'step_1' });
    expect(upgrades).toHaveLength(1);
    expect(posts).toBe(1);
    expect(resolveWsTransport('wrun_1', config)).toBeNull();

    await writeStepCompleted();

    expect(upgrades).toHaveLength(1);
    expect(posts).toBe(2);
  });

  it.runIf(mode === 'hang')(
    'fails the waiting write and drops the socket',
    async () => {
      const wsUrl = `${process.env.VERCEL_WORKFLOW_SERVER_URL}/websockets/v1/runs/wrun_1`;
      const transport = getWsEventsTransport(wsUrl, async () => ({}));
      transport.open();
      const write = transport.request(eventFrame).catch((err: Error) => err);
      while (upgrades.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const ended = new Promise((resolve) => upgrades[0].once('end', resolve));

      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      await ended;

      expect((await write) as Error).toBeInstanceOf(Error);
      expect(((await write) as Error).message).toMatch(
        /handshake .* timed out/
      );
      expect(getWsEventsTransport(wsUrl, async () => ({}))).not.toBe(transport);
    }
  );
});
