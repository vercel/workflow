/**
 * The events channel across queue deliveries. The flow route opens one channel
 * per delivery and releases it when the delivery ends; with linger, the next
 * delivery for the same run on the same instance reclaims the socket instead
 * of paying for a new handshake.
 *
 * Driven through the real `createQueueHandler`, with `@vercel/queue` and `ws`
 * replaced, so it covers the claim/release pairing in `queue.ts` rather than
 * the transport in isolation (`ws-transport.test.ts` does that).
 */

import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const { mockHandleCallback, MockQueueClient, sockets, FakeWebSocket } =
  vi.hoisted(() => {
    const mockHandleCallback = vi.fn();
    // biome-ignore lint/complexity/useArrowFunction: needs to be newable
    const MockQueueClient = vi.fn().mockImplementation(function () {
      return {
        send: vi.fn(),
        experimental_sendBatch: vi.fn(),
        handleCallback: mockHandleCallback,
      };
    });

    const sockets: FakeSocket[] = [];
    class FakeSocket {
      static readonly OPEN = 1;
      readyState = 0;
      binaryType = '';
      readonly pings: string[] = [];
      _socket = {
        refed: true,
        ref() {
          this.refed = true;
        },
        unref() {
          this.refed = false;
        },
      };
      private readonly listeners = new Map<
        string,
        Array<(...a: unknown[]) => void>
      >();
      constructor(_url: string, _opts?: unknown) {
        sockets.push(this);
      }
      on(event: string, cb: (...a: unknown[]) => void): this {
        const l = this.listeners.get(event) ?? [];
        l.push(cb);
        this.listeners.set(event, l);
        return this;
      }
      emit(event: string, ...args: unknown[]): void {
        for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args);
      }
      send(_data: Uint8Array, cb?: (err?: Error) => void): void {
        cb?.();
      }
      close(code = 1000): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.emit('close', code);
      }
      terminate(): void {
        this.close(1006);
      }
      ping(data: Buffer, _mask?: boolean, cb?: (err?: Error) => void): void {
        this.pings.push(data.toString());
        cb?.();
        queueMicrotask(() => this.emit('pong', data));
      }
      open(): void {
        this.readyState = 1;
        this.emit('open');
      }
    }

    return {
      mockHandleCallback,
      MockQueueClient,
      sockets,
      FakeWebSocket: FakeSocket,
    };
  });

vi.mock('@vercel/queue', () => ({
  QueueClient: MockQueueClient,
  ConsumerDiscoveryError: class extends Error {},
}));
vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));

import { createQueue } from './queue.js';
import { resetWsEventsTransportsForTest } from './ws-transport.js';

type Delivery = (message: unknown, metadata: unknown) => Promise<void>;

/** The flow route's callback, with a handler that waits for the channel's
 *  socket and completes its handshake the first time one appears. */
function setupRoute() {
  let delivery: Delivery | undefined;
  mockHandleCallback.mockImplementation((handler: Delivery) => {
    delivery = handler;
    return async () => new Response('ok');
  });
  createQueue({ token: 'test-token' }).createQueueHandler(
    '__wkf_workflow_',
    async () => {
      // This delivery's socket: a reclaimed one that is already open, or a
      // fresh one still handshaking. Never one an earlier delivery closed.
      await vi.waitFor(() =>
        expect(sockets.at(-1)?.readyState).toBeOneOf([0, 1])
      );
      const socket = sockets.at(-1);
      if (socket?.readyState === 0) socket.open();
      return undefined;
    }
  );
  assert(delivery);
  const deliver = delivery;
  return (messageId: string) =>
    deliver(
      { payload: { runId: 'wrun_1' }, queueName: '__wkf_workflow_test' },
      { messageId, deliveryCount: 1 }
    );
}

beforeEach(() => {
  sockets.length = 0;
  resetWsEventsTransportsForTest();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  resetWsEventsTransportsForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('events channel across deliveries', () => {
  it('reuses one socket for back-to-back deliveries of a run', async () => {
    const deliver = setupRoute();

    await deliver('msg-1');
    const socket = sockets[0];
    // Released, but kept open without holding the process.
    expect(socket.readyState).toBe(1);
    expect(socket._socket.refed).toBe(false);

    await deliver('msg-2');

    expect(sockets).toHaveLength(1);
    expect(socket.pings).toHaveLength(1);
    expect(socket.readyState).toBe(1);
  });

  it('opens a socket per delivery with linger disabled', async () => {
    vi.stubEnv('WORKFLOW_EVENTS_TRANSPORT_WS_LINGER_MS', '0');
    const deliver = setupRoute();

    await deliver('msg-1');
    expect(sockets[0].readyState).toBe(3);
    await deliver('msg-2');

    expect(sockets).toHaveLength(2);
  });

  it('closes the lingering socket once the window passes', async () => {
    vi.stubEnv('WORKFLOW_EVENTS_TRANSPORT_WS_LINGER_MS', '20');
    const deliver = setupRoute();

    await deliver('msg-1');
    expect(sockets[0].readyState).toBe(1);

    await vi.waitFor(() => expect(sockets[0].readyState).toBe(3));
  });
});
