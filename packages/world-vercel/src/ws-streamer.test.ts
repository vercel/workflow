import { decode } from 'cbor-x';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame } from './frames.js';
import {
  closeStreamOverWs,
  resetWsStreamWritersForTest,
  writeMultiStreamOverWs,
  writeStreamOverWs,
} from './ws-streamer.js';

const { sockets, socketBehavior, FakeSocket } = vi.hoisted(() => {
  class FakeSocket {
    static OPEN = 1;
    readyState = FakeSocket.OPEN;
    sent: Uint8Array[] = [];
    url: string;
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(url: string) {
      this.url = url;
      sockets.push(this);
      if (socketBehavior.autoOpen) queueMicrotask(() => this.emit('open'));
    }

    on(event: string, callback: (...args: never[]) => void) {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        callback as (...args: unknown[]) => void,
      ]);
      return this;
    }

    once(event: string, callback: (...args: never[]) => void) {
      const once = (...args: unknown[]) => {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter((item) => item !== once)
        );
        callback(...(args as never[]));
      };
      return this.on(event, once as (...args: never[]) => void);
    }

    emit(event: string, ...args: unknown[]) {
      for (const callback of this.listeners.get(event) ?? []) callback(...args);
    }

    send(frame: Uint8Array, callback: (error?: Error) => void) {
      this.sent.push(frame);
      callback();
    }

    close() {
      this.readyState = 3;
    }

    failUpgrade(error = new Error('upgrade declined')) {
      this.emit('error', error);
      this.emit('close');
    }
  }

  const sockets: FakeSocket[] = [];
  const socketBehavior = { autoOpen: true };
  return { sockets, socketBehavior, FakeSocket };
});

vi.mock('ws', () => ({ WebSocket: FakeSocket }));
vi.mock('./utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./utils.js')>()),
  getHttpUrl: () => ({
    baseUrl: 'https://example.test/api',
    usingProxy: false,
  }),
  getHttpConfig: async () => ({
    baseUrl: 'https://example.test/api',
    headers: new Headers({ authorization: 'Bearer test' }),
  }),
}));

function metaOf(raw: Uint8Array): Record<string, unknown> {
  const metaLength = new DataView(
    raw.buffer,
    raw.byteOffset,
    raw.byteLength
  ).getUint32(0, false);
  return decode(raw.subarray(4, 4 + metaLength)) as Record<string, unknown>;
}

function bodyOf(raw: Uint8Array): Uint8Array {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const metaLength = view.getUint32(0, false);
  const bodyOffset = 4 + metaLength;
  const bodyLength = view.getUint32(bodyOffset, false);
  return raw.slice(bodyOffset + 4, bodyOffset + 4 + bodyLength);
}

function ack(socket: InstanceType<typeof FakeSocket>, index = 1): void {
  const sent = socket.sent.at(-1);
  if (!sent) throw new Error('socket has no sent frame to acknowledge');
  const reqId = metaOf(sent).reqId;
  socket.emit(
    'message',
    Buffer.from(
      encodeFrame(
        { reqId, type: 'stream_ack', status: 200, nextIndex: index },
        new Uint8Array(0)
      )
    )
  );
}

async function waitForSocket(): Promise<FakeSocket> {
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return sockets[0];
}

beforeEach(() => {
  resetWsStreamWritersForTest();
  sockets.length = 0;
  socketBehavior.autoOpen = true;
  delete process.env.WORKFLOW_MAX_CHUNKS_PER_REQUEST;
});

describe('per-stream WebSocket writer', () => {
  it('uses HTTP for the first write while opening the stream-scoped socket', async () => {
    const http = vi.fn(async () => {});
    await writeStreamOverWs('run/a', 'output/b', 'first', undefined, http);
    const socket = await waitForSocket();

    expect(http).toHaveBeenCalledOnce();
    expect(socket.url).toBe(
      'wss://example.test/api/websockets/v1/runs/run%2Fa/streams/output%2Fb'
    );
    expect(socket.sent).toHaveLength(0);
  });

  it('attempts a declined upgrade only once until close removes the tombstone', async () => {
    socketBehavior.autoOpen = false;
    const firstHttp = vi.fn(async () => {});
    await writeStreamOverWs('run-1', 'declined', 'first', undefined, firstHttp);
    const socket = await waitForSocket();
    socket.failUpgrade();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondHttp = vi.fn(async () => {});
    const multiHttp = vi.fn(async () => {});
    await writeStreamOverWs(
      'run-1',
      'declined',
      'second',
      undefined,
      secondHttp
    );
    await writeMultiStreamOverWs(
      'run-1',
      'declined',
      ['third', 'fourth'],
      undefined,
      multiHttp
    );

    expect(sockets).toHaveLength(1);
    expect(firstHttp).toHaveBeenCalledOnce();
    expect(secondHttp).toHaveBeenCalledOnce();
    expect(multiHttp).toHaveBeenCalledOnce();

    const closeHttp = vi.fn(async () => {});
    await closeStreamOverWs('run-1', 'declined', undefined, closeHttp);
    expect(closeHttp).toHaveBeenCalledOnce();

    await writeStreamOverWs(
      'run-1',
      'declined',
      'new lifecycle',
      undefined,
      async () => {}
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
  });

  it('writes without a redundant stream name after the HTTP barrier', async () => {
    await writeStreamOverWs(
      'run-1',
      'output',
      'first',
      undefined,
      async () => {}
    );
    const socket = await waitForSocket();

    const second = writeStreamOverWs(
      'run-1',
      'output',
      'second',
      undefined,
      async () => {
        throw new Error('unexpected HTTP fallback');
      }
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(metaOf(socket.sent[0])).toEqual({
      reqId: 1,
      type: 'stream_write',
      count: 1,
    });
    expect(new TextDecoder().decode(bodyOf(socket.sent[0]))).toBe('second');
    ack(socket);
    await second;
  });

  it('keeps at most five batches in flight and sends the next page after ACKs', async () => {
    process.env.WORKFLOW_MAX_CHUNKS_PER_REQUEST = '1';
    await writeStreamOverWs(
      'run-1',
      'output',
      'first',
      undefined,
      async () => {}
    );
    const socket = await waitForSocket();

    const write = writeMultiStreamOverWs(
      'run-1',
      'output',
      ['a', 'b', 'c', 'd', 'e', 'f'],
      undefined,
      async () => {
        throw new Error('unexpected HTTP fallback');
      }
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(5));
    expect(socket.sent.map(metaOf)).toEqual(
      [1, 2, 3, 4, 5].map((reqId) => ({
        reqId,
        type: 'stream_write',
        count: 1,
      }))
    );

    for (let i = 0; i < 5; i++) {
      const reqId = i + 1;
      socket.emit(
        'message',
        Buffer.from(
          encodeFrame(
            { reqId, type: 'stream_ack', status: 200, nextIndex: reqId },
            new Uint8Array(0)
          )
        )
      );
    }
    await vi.waitFor(() => expect(socket.sent).toHaveLength(6));
    ack(socket, 6);
    await write;
  });

  it('keeps close on HTTP while the upgrade or HTTP barrier is pending', async () => {
    let releaseHttp!: () => void;
    const pendingHttp = new Promise<void>((resolve) => {
      releaseHttp = resolve;
    });
    const first = writeStreamOverWs(
      'run-1',
      'output',
      'first',
      undefined,
      () => pendingHttp
    );
    const socket = await waitForSocket();
    const closeHttp = vi.fn(async () => {});
    const close = closeStreamOverWs('run-1', 'output', undefined, closeHttp);

    expect(socket.readyState).toBe(3);
    expect(closeHttp).not.toHaveBeenCalled();
    releaseHttp();
    await Promise.all([first, close]);
    expect(closeHttp).toHaveBeenCalledOnce();
    expect(socket.sent).toHaveLength(0);
  });

  it('closes over the socket after a stream_close ACK', async () => {
    await writeStreamOverWs(
      'run-1',
      'output',
      'first',
      undefined,
      async () => {}
    );
    const socket = await waitForSocket();
    const close = closeStreamOverWs('run-1', 'output', undefined, async () => {
      throw new Error('unexpected HTTP close');
    });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(metaOf(socket.sent[0])).toEqual({
      reqId: 1,
      type: 'stream_close',
    });
    ack(socket);
    await close;
    expect(socket.readyState).toBe(3);
  });
});
