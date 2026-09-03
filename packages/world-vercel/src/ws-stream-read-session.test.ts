import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFrames, encodeFrame } from './frames.js';

const { FakeWebSocket, sockets } = vi.hoisted(() => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static readonly OPEN = 1;
    readyState = 0;
    sent: Uint8Array[] = [];
    closed: Array<[number, string]> = [];
    binaryType = '';
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(readonly url: string) {
      sockets.push(this);
    }
    on(event: string, callback: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(callback);
      this.listeners.set(event, list);
      return this;
    }
    once(event: string, callback: (...args: unknown[]) => void): this {
      const wrapper = (...args: unknown[]) => {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter((item) => item !== wrapper)
        );
        callback(...args);
      };
      return this.on(event, wrapper);
    }
    emit(event: string, ...args: unknown[]): void {
      for (const callback of [...(this.listeners.get(event) ?? [])]) {
        callback(...args);
      }
    }
    open(): void {
      this.readyState = 1;
      this.emit('open');
    }
    send(frame: Uint8Array): void {
      this.sent.push(frame);
    }
    close(code = 1000, reason = ''): void {
      this.readyState = 3;
      this.closed.push([code, reason]);
    }
    reply(meta: Record<string, unknown>, body = new Uint8Array()): void {
      this.emit('message', encodeFrame(meta, body));
    }
  }
  return { FakeWebSocket: FakeSocket, sockets };
});

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));
vi.mock('./telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./telemetry.js')>()),
  injectTraceContextIntoHeaders: vi.fn(),
}));

const { createStreamReadWsSession } = await import(
  './ws-stream-read-session.js'
);

beforeEach(() => {
  sockets.length = 0;
});

function makeFallbacks() {
  return {
    resolveStartIndex: vi.fn(async (startIndex: number) => startIndex),
    getChunks: vi.fn(),
    getInfo: vi.fn(),
  };
}

async function decodeSentMeta(raw: Uint8Array) {
  for await (const frame of decodeFrames(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(raw);
        controller.close();
      },
    })
  )) {
    return frame.meta;
  }
  throw new Error('missing frame');
}

async function open(stream: ReadableStream<Uint8Array>, startIndex = 0) {
  const reader = stream.getReader();
  const reading = reader.read();
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0].open();
  sockets[0].reply({
    type: 'opened',
    requestedStartIndex: startIndex,
    resolvedStartIndex: startIndex < 0 ? 42 : startIndex,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { reader, reading, socket: sockets[0] };
}

describe('stream read WebSocket session', () => {
  it('keeps a bounded four-chunk credit window', async () => {
    const fallbacks = makeFallbacks();
    const stream = createStreamReadWsSession(
      'wrun_1',
      'stream',
      0,
      { token: 'token' },
      fallbacks
    );
    const { reader, reading, socket } = await open(stream);
    // `opened` grants one implicit connection-local credit, then the client
    // fills only the remaining downstream capacity.
    expect(socket.sent).toHaveLength(1);
    await expect(decodeSentMeta(socket.sent[0])).resolves.toMatchObject({
      type: 'credit',
      chunks: 3,
    });
    socket.reply({ type: 'chunk', index: 0 }, new Uint8Array([1]));
    await expect(reading).resolves.toEqual({
      done: false,
      value: new Uint8Array([1]),
    });

    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    await expect(decodeSentMeta(socket.sent[1])).resolves.toMatchObject({
      type: 'credit',
      chunks: 1,
    });
    const second = reader.read();
    socket.reply({ type: 'chunk', index: 1 }, new Uint8Array([2]));
    await expect(second).resolves.toEqual({
      done: false,
      value: new Uint8Array([2]),
    });
    await reader.cancel();
  });

  it('does not grant credit without downstream queue capacity', async () => {
    const stream = createStreamReadWsSession(
      'wrun_1',
      'stream',
      0,
      { token: 'token' },
      makeFallbacks()
    );
    const { reader, reading, socket } = await open(stream);
    for (let index = 0; index < 5; index++) {
      socket.reply({ type: 'chunk', index }, new Uint8Array([index]));
    }
    await reading;
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Initial +3 plus one replacement for the directly-consumed first chunk.
    // Four queued chunks leave desiredSize=0, so no further credit is sent.
    expect(socket.sent).toHaveLength(2);
    await expect(decodeSentMeta(socket.sent[1])).resolves.toMatchObject({
      type: 'credit',
      chunks: 1,
    });

    // Draining one queued chunk creates exactly one slot and one replacement
    // credit. Filling that slot consumes the credit without granting another.
    await expect(reader.read()).resolves.toMatchObject({
      value: new Uint8Array([1]),
    });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    await expect(decodeSentMeta(socket.sent[2])).resolves.toMatchObject({
      type: 'credit',
      chunks: 1,
    });
    socket.reply({ type: 'chunk', index: 5 }, new Uint8Array([5]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socket.sent).toHaveLength(3);
    await reader.cancel();
  });

  it('discards duplicate chunks and restores demanded credit', async () => {
    const stream = createStreamReadWsSession(
      'wrun_1',
      'stream',
      0,
      { token: 'token' },
      makeFallbacks()
    );
    const { reader, reading, socket } = await open(stream);
    socket.reply({ type: 'chunk', index: 0 }, new Uint8Array([1]));
    await reading;
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const second = reader.read();
    socket.reply({ type: 'chunk', index: 0 }, new Uint8Array([9]));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    await expect(decodeSentMeta(socket.sent[2])).resolves.toMatchObject({
      type: 'credit',
      chunks: 1,
    });
    socket.reply({ type: 'chunk', index: 1 }, new Uint8Array([2]));
    await expect(second).resolves.toMatchObject({ value: new Uint8Array([2]) });
    await reader.cancel();
  });

  it('resets the reconnect budget after forward progress', async () => {
    const stream = createStreamReadWsSession(
      'wrun_1',
      'stream',
      0,
      { token: 'token' },
      makeFallbacks()
    );
    const reader = stream.getReader();
    let reading = reader.read();

    for (let index = 0; index < 5; index++) {
      await vi.waitFor(() => expect(sockets).toHaveLength(index + 1));
      const socket = sockets[index];
      socket.open();
      socket.reply({
        type: 'opened',
        requestedStartIndex: index,
        resolvedStartIndex: index,
      });
      socket.reply({ type: 'chunk', index }, new Uint8Array([index]));
      await expect(reading).resolves.toMatchObject({
        value: new Uint8Array([index]),
      });
      if (index < 4) {
        reading = reader.read();
        socket.reply({ type: 'end', reason: 'drain' });
      }
    }

    expect(sockets).toHaveLength(5);
    await reader.cancel();
  });

  it('ignores queued frames from a superseded socket attempt', async () => {
    const stream = createStreamReadWsSession(
      'wrun_1',
      'stream',
      0,
      { token: 'token' },
      makeFallbacks()
    );
    const { reader, reading, socket: first } = await open(stream);
    first.reply({ type: 'end', reason: 'capacity' });
    first.reply({ type: 'chunk', index: 0 }, new Uint8Array([99]));

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    const second = sockets[1];
    second.open();
    second.reply({
      type: 'opened',
      requestedStartIndex: 0,
      resolvedStartIndex: 0,
    });
    second.reply({ type: 'chunk', index: 0 }, new Uint8Array([1]));

    await expect(reading).resolves.toMatchObject({
      value: new Uint8Array([1]),
    });
    await reader.cancel();
  });

  it('ignores stale lifecycle callbacks while a replacement connects', async () => {
    const stream = createStreamReadWsSession(
      'wrun_1',
      'stream',
      0,
      { token: 'token' },
      makeFallbacks()
    );
    const { reader, reading, socket: first } = await open(stream);
    first.reply({ type: 'end', reason: 'capacity' });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    const second = sockets[1];

    first.emit('error', new Error('late old-socket error'));
    second.open();
    second.reply({
      type: 'opened',
      requestedStartIndex: 0,
      resolvedStartIndex: 0,
    });
    second.reply({ type: 'chunk', index: 0 }, new Uint8Array([1]));

    await expect(reading).resolves.toMatchObject({
      value: new Uint8Array([1]),
    });
    await reader.cancel();
  });

  it('accepts explicit EOF when starting beyond the terminal tail', async () => {
    const stream = createStreamReadWsSession(
      'wrun_1',
      'stream',
      10,
      { token: 'token' },
      makeFallbacks()
    );
    const { reading, socket } = await open(stream, 10);
    socket.reply({ type: 'eof', finalIndex: 4, nextIndex: 5 });
    await expect(reading).resolves.toEqual({ done: true, value: undefined });
  });

  it('treats fatal error as terminal', async () => {
    const stream = createStreamReadWsSession(
      'wrun_1',
      'stream',
      0,
      { token: 'token' },
      makeFallbacks()
    );
    const { reading, socket } = await open(stream);
    socket.reply({
      type: 'error',
      status: 410,
      code: 'read_failed',
      message: 'expired',
    });
    await expect(reading).rejects.toThrow('expired');
  });

  it('cancels with a bounded acknowledgement', async () => {
    const stream = createStreamReadWsSession(
      'wrun_1',
      'stream',
      0,
      { token: 'token' },
      makeFallbacks()
    );
    const { reader, socket } = await open(stream);
    const cancelling = reader.cancel('stop');
    await vi.waitFor(() =>
      expect(socket.sent.length).toBeGreaterThanOrEqual(2)
    );
    const cancelFrame = socket.sent.at(-1);
    expect(cancelFrame).toBeDefined();
    await expect(
      decodeSentMeta(cancelFrame as Uint8Array)
    ).resolves.toMatchObject({
      type: 'cancel',
      reqId: 1,
    });
    socket.reply({ type: 'cancel_ack', reqId: 1 });
    await expect(
      Promise.race([
        cancelling.then(() => 'acknowledged'),
        new Promise((resolve) => setTimeout(() => resolve('timed out'), 100)),
      ])
    ).resolves.toBe('acknowledged');
    expect(socket.closed).toContainEqual([1000, 'reader cancelled']);
  });

  it('claims one pre-open HTTP fallback across competing terminal signals', async () => {
    const fallbacks = makeFallbacks();
    fallbacks.getChunks
      .mockResolvedValueOnce({
        data: [{ index: 0, data: new Uint8Array([1]) }],
        cursor: null,
        hasMore: false,
        done: false,
      })
      .mockResolvedValue({
        data: [],
        cursor: null,
        hasMore: false,
        done: true,
      });
    fallbacks.getInfo.mockResolvedValue({ tailIndex: 0, done: true });
    const stream = createStreamReadWsSession(
      'wrun_1',
      'stream',
      0,
      { token: 'token' },
      fallbacks
    );
    const reader = stream.getReader();
    const reading = reader.read();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const response = { resume: vi.fn(), destroy: vi.fn() };
    sockets[0].emit('unexpected-response', {}, response);
    sockets[0].emit('error', new Error('declined'));
    sockets[0].emit('close');

    await expect(reading).resolves.toMatchObject({
      value: new Uint8Array([1]),
    });
    expect(fallbacks.resolveStartIndex).toHaveBeenCalledTimes(1);
    expect(fallbacks.getChunks).toHaveBeenCalled();
    await reader.cancel();
  });

  it('cancels while authoritative position resolution is pending', async () => {
    let resolveStart: ((index: number) => void) | undefined;
    const fallbacks = makeFallbacks();
    fallbacks.resolveStartIndex.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      })
    );
    const stream = createStreamReadWsSession(
      'wrun_1',
      'stream',
      0,
      { token: 'token' },
      fallbacks
    );
    const reader = stream.getReader();
    void reader.read();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].emit('unexpected-response', {}, {});
    await vi.waitFor(() =>
      expect(fallbacks.resolveStartIndex).toHaveBeenCalledTimes(1)
    );
    const cancelling = reader.cancel();
    resolveStart?.(0);
    await cancelling;
    expect(fallbacks.getChunks).not.toHaveBeenCalled();
  });

  it('uses indexed pages after opened recovery and validates gaps', async () => {
    const fallbacks = makeFallbacks();
    fallbacks.getChunks.mockResolvedValue({
      data: [{ index: 2, data: new Uint8Array([2]) }],
      cursor: null,
      hasMore: false,
      done: false,
    });
    fallbacks.getInfo.mockResolvedValue({ tailIndex: 2, done: false });
    const stream = createStreamReadWsSession(
      'wrun_1',
      'stream',
      0,
      { token: 'token' },
      fallbacks
    );
    const { reading, socket } = await open(stream);
    socket.reply({ type: 'end', reason: 'capacity' });
    // Exhaust WS reconnects with accepted/opened attempts ending immediately.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await vi.waitFor(() => expect(sockets).toHaveLength(attempt + 1));
      sockets[attempt].open();
      sockets[attempt].reply({
        type: 'opened',
        requestedStartIndex: 0,
        resolvedStartIndex: 0,
      });
      sockets[attempt].reply({ type: 'end', reason: 'capacity' });
    }
    await expect(reading).rejects.toThrow('expected 0, received 2');
    expect(fallbacks.resolveStartIndex).not.toHaveBeenCalled();
  });
});
