import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFrame, encodeFrame } from './frames.js';
import type { APIConfig } from './utils.js';

const {
  FakeWebSocket,
  getVercelOidcToken,
  injectTraceContextIntoHeaders,
  sockets,
  writeSpans,
} = vi.hoisted(() => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static readonly OPEN = 1;
    readyState = 0;
    binaryType = '';
    sent: Uint8Array[] = [];
    closed: Array<[number, string]> = [];
    throwOnSend: Error | undefined;
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(
      readonly url: string,
      readonly options: unknown
    ) {
      sockets.push(this);
    }
    on(event: string, callback: (...args: unknown[]) => void): this {
      const callbacks = this.listeners.get(event) ?? [];
      callbacks.push(callback);
      this.listeners.set(event, callbacks);
      return this;
    }
    once(event: string, callback: (...args: unknown[]) => void): this {
      const wrapper = (...args: unknown[]) => {
        this.off(event, wrapper);
        callback(...args);
      };
      return this.on(event, wrapper);
    }
    off(event: string, callback: (...args: unknown[]) => void): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((item) => item !== callback)
      );
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const callback of [...(this.listeners.get(event) ?? [])]) {
        callback(...args);
      }
    }
    send(frame: Uint8Array, callback?: (error?: Error) => void): void {
      if (this.throwOnSend) throw this.throwOnSend;
      this.sent.push(frame);
      callback?.();
    }
    close(code = 1000, reason = ''): void {
      this.closed.push([code, reason]);
      this.readyState = 3;
    }
    open(): void {
      this.readyState = FakeSocket.OPEN;
      this.emit('open');
    }
    reply(frame: Uint8Array): void {
      this.emit('message', Buffer.from(frame));
    }
  }
  return {
    FakeWebSocket: FakeSocket,
    getVercelOidcToken: vi.fn().mockResolvedValue(undefined),
    injectTraceContextIntoHeaders: vi.fn(),
    sockets,
    writeSpans: [] as Array<Record<string, unknown>>,
  };
});

const { batchEndOverride } = vi.hoisted(() => ({
  batchEndOverride: {
    fn: undefined as
      | ((chunks: readonly Uint8Array[], start: number) => number)
      | undefined,
  },
}));

vi.mock('@vercel/oidc', () => ({ getVercelOidcToken }));
vi.mock('./stream-ws-protocol-v1.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./stream-ws-protocol-v1.js')>();
  return {
    ...actual,
    streamWsWriteBatchEnd: (
      chunks: readonly Uint8Array[],
      start: number,
      maxMessageBytes: number
    ) =>
      batchEndOverride.fn?.(chunks, start) ??
      actual.streamWsWriteBatchEnd(chunks, start, maxMessageBytes),
  };
});
vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));
vi.mock('./telemetry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./telemetry.js')>();
  return { ...actual, injectTraceContextIntoHeaders };
});
vi.mock('./http-core.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http-core.js')>();
  return {
    ...actual,
    withHttpClientSpan: vi.fn(async (options, callback) => {
      if (options.spanName !== 'workflow.stream.write') {
        return callback(undefined);
      }
      const attributes = { ...options.attributes };
      writeSpans.push(attributes);
      return callback({
        setAttributes(next: Record<string, unknown>) {
          Object.assign(attributes, next);
        },
      });
    }),
  };
});

const { createStreamWriteSession } = await import('./ws-stream-session.js');
const { DEFAULT_WS_MAX_MESSAGE_BYTES, MIN_WS_MAX_MESSAGE_BYTES } = await import(
  './ws-parts.js'
);

async function decodeOne(raw: Uint8Array) {
  return decodeFrame(raw);
}

/** Byte equality without vitest's element-by-element deep comparison, which
 *  takes tens of seconds for the multi-MiB arrays the size-limit tests use. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  );
}

const writerId = 'wrtr_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const activeSessions: Array<{ dispose?(): void }> = [];

beforeEach(() => {
  sockets.length = 0;
  getVercelOidcToken.mockReset().mockResolvedValue(undefined);
  injectTraceContextIntoHeaders.mockClear();
  writeSpans.length = 0;
  delete process.env.WORKFLOW_STREAMS_TRANSPORT;
  delete process.env.WORKFLOW_REQUEST_TIMEOUT_MS;
  delete process.env.WORKFLOW_WS_MAX_MESSAGE_BYTES;
  batchEndOverride.fn = undefined;
});

afterEach(() => {
  for (const session of activeSessions.splice(0)) session.dispose?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeSession(
  config: APIConfig | undefined = { token: 'token' },
  connectAfterFirstWrite = false
) {
  const writeHttp = vi.fn(
    async (
      _chunks: (string | Uint8Array)[],
      _attributes?: Record<string, unknown>,
      onRequestDispatched?: () => void
    ) => {
      onRequestDispatched?.();
    }
  );
  const closeHttp = vi.fn().mockResolvedValue(undefined);
  const session = createStreamWriteSession(
    'wrun_1',
    'stream/1',
    writerId,
    config,
    writeHttp,
    closeHttp,
    connectAfterFirstWrite
  );
  activeSessions.push(session);
  return { session, writeHttp, closeHttp };
}

describe('v1 stream WebSocket writer lifecycle', () => {
  it('opens a socket by default, with no env var set', async () => {
    makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
  });

  it.each([
    'http',
    'HTTP',
    ' http ',
  ])('stays on HTTP without constructing a socket on the %j opt-out', async (value) => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = value;
    const { session, writeHttp, closeHttp } = makeSession();
    await session.write(0, ['one']);
    await session.close();

    expect(sockets).toHaveLength(0);
    expect(writeHttp).toHaveBeenCalledWith(['one']);
    expect(closeHttp).toHaveBeenCalledTimes(1);
  });

  it('stays on HTTP for a projectConfig World without constructing a socket', async () => {
    const { session, writeHttp, closeHttp } = makeSession({
      token: 'token',
      projectConfig: { projectId: 'prj_test', teamId: 'team_test' },
    });
    await session.write(0, ['one']);
    await session.close();

    expect(sockets).toHaveLength(0);
    expect(writeHttp.mock.calls.map((call) => call[0])).toEqual([['one']]);
    expect(closeHttp).toHaveBeenCalledTimes(1);
  });

  it('starts WS during the second HTTP group and keeps writing HTTP until OPEN', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    let releaseSecond: (() => void) | undefined;
    const secondPending = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const { session, writeHttp } = makeSession({ token: 'token' }, true);

    await session.write(0, ['one']);
    expect(sockets).toHaveLength(0);
    expect(writeHttp).toHaveBeenNthCalledWith(
      1,
      ['one'],
      expect.objectContaining({
        'workflow.stream.ws.session_first_write': true,
        'workflow.stream.ws.http_group_ordinal': 1,
      })
    );

    writeHttp.mockImplementationOnce(
      async (_chunks, _attributes, dispatched) => {
        dispatched?.();
        await secondPending;
      }
    );
    const second = session.write(1, ['two']);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(writeHttp).toHaveBeenNthCalledWith(
      2,
      ['two'],
      expect.objectContaining({
        'workflow.stream.ws.connect_after_http_group': 2,
      }),
      expect.any(Function)
    );
    expect(sockets[0].sent).toHaveLength(0);
    releaseSecond?.();
    await second;

    const third = session.write(2, ['three']);
    await third;
    expect(writeHttp.mock.calls[2]?.[0]).toEqual(['three']);
    sockets[0].open();

    const fourth = session.write(3, ['four']);
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    expect((await decodeOne(sockets[0].sent[0])).meta).toMatchObject({
      type: 'write',
      chunkSeq: 3,
      numChunks: 1,
    });
    sockets[0].reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await fourth;
  });

  it('closes over HTTP without waiting for the background socket', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, closeHttp } = makeSession({ token: 'token' }, true);
    await session.write(0, ['one']);
    await session.write(1, ['two']);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    await session.close();
    expect(closeHttp).toHaveBeenCalledTimes(1);
    expect(sockets[0].closed).toContainEqual([1000, 'stream closed over HTTP']);
  });

  it('retires a provisional socket after an ambiguous second HTTP outcome', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const error = new Error('second HTTP outcome unknown');
    const { session, writeHttp } = makeSession({ token: 'token' }, true);
    await session.write(0, ['one']);
    let rejectSecond: ((error: Error) => void) | undefined;
    const secondPending = new Promise<void>((_resolve, reject) => {
      rejectSecond = reject;
    });
    writeHttp.mockImplementationOnce(
      async (_chunks, _attributes, dispatched) => {
        dispatched?.();
        await secondPending;
      }
    );

    const second = session.write(1, ['two']);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    rejectSecond?.(error);
    await expect(second).rejects.toBe(error);
    await expect(session.write(2, ['three'])).rejects.toBe(error);
    expect(sockets[0].sent).toHaveLength(0);
    expect(sockets[0].closed).toContainEqual([
      1011,
      'unknown stream write outcome',
    ]);
  });

  it('does not start a socket after an ambiguous first HTTP outcome', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const error = new Error('HTTP outcome unknown');
    const { session, writeHttp } = makeSession({ token: 'token' }, true);
    writeHttp.mockRejectedValueOnce(error);

    await expect(session.write(0, ['one'])).rejects.toBe(error);
    await expect(session.write(1, ['two'])).rejects.toBe(error);
    expect(sockets).toHaveLength(0);
  });

  it('closes a one-group stream without starting a socket', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, closeHttp } = makeSession({ token: 'token' }, true);

    await session.write(0, ['only']);
    await session.close();
    expect(closeHttp).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(0);
  });

  it('sends immediately over HTTP while the initial socket connects, then switches to WS', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    let releaseHttp: (() => void) | undefined;
    const httpPending = new Promise<void>((resolve) => {
      releaseHttp = resolve;
    });
    const { session, writeHttp } = makeSession();
    writeHttp.mockImplementationOnce(async () => httpPending);

    const first = session.write(0, ['one']);
    await vi.waitFor(() =>
      expect(writeHttp).toHaveBeenCalledWith(
        ['one'],
        expect.objectContaining({
          'workflow.stream.ws.session_first_write': true,
          'workflow.stream.ws.connecting_at_write': true,
          'workflow.stream.ws.connection_attempt': 1,
        })
      )
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    const second = session.write(1, ['two']);

    // Transport switching happens only after the HTTP group's outcome is
    // known, so the later WS sequence can never overtake it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets[0].sent).toHaveLength(0);
    releaseHttp?.();
    await first;
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    expect((await decodeOne(sockets[0].sent[0])).meta).toMatchObject({
      type: 'write',
      chunkSeq: 1,
    });
    sockets[0].reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await second;

    expect(writeSpans).toHaveLength(1);
    expect(writeSpans[0]).toMatchObject({
      'workflow.stream.ws.session_first_write': false,
      'workflow.stream.ws.connection_first_write': true,
      'workflow.stream.ws.connection_attempt': 1,
    });
    for (const attribute of [
      'workflow.stream.ws.session_to_write_ms',
      'workflow.stream.ws.write_wait_for_open_ms',
      'workflow.stream.ws.write_to_send_ms',
      'workflow.stream.ws.open_to_send_ms',
      'workflow.stream.ws.connect_ms',
      'workflow.stream.ws.config_token_ms',
      'workflow.stream.ws.send_to_reply_ms',
      'workflow.stream.ws.reply_processing_ms',
      'workflow.stream.ws.write_total_ms',
    ]) {
      expect(writeSpans[0][attribute]).toEqual(expect.any(Number));
      expect(writeSpans[0][attribute]).toBeGreaterThanOrEqual(0);
    }
  });

  it('uses WS for the first write when the socket is already open', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    sockets[0].reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );

    await writing;
    expect(writeHttp).not.toHaveBeenCalled();
    expect(writeSpans[0]).toMatchObject({
      'workflow.stream.ws.session_first_write': true,
      'workflow.stream.ws.connection_first_write': true,
    });
  });

  it('bounds the background connect attempt without delaying HTTP writes', async () => {
    vi.useFakeTimers();
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    process.env.WORKFLOW_REQUEST_TIMEOUT_MS = '10000';
    const { session, writeHttp } = makeSession({ token: 'token' }, true);
    const first = session.write(0, ['one']);
    await vi.waitFor(() =>
      expect(writeHttp).toHaveBeenCalledWith(
        ['one'],
        expect.objectContaining({
          'workflow.stream.ws.session_first_write': true,
          'workflow.stream.ws.connecting_at_write': false,
          'workflow.stream.ws.connect_deferred_at_write': true,
        })
      )
    );
    await first;
    expect(sockets).toHaveLength(0);
    await session.write(1, ['two']);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(10_000);
    await session.write(2, ['three']);
    expect(writeHttp).toHaveBeenCalledTimes(3);
    expect(writeHttp.mock.calls[0]?.[0]).toEqual(['one']);
    expect(writeHttp.mock.calls[1]?.[0]).toEqual(['two']);
    expect(writeHttp.mock.calls[2]).toEqual([['three']]);
    expect(sockets[0].sent).toHaveLength(0);
    expect(sockets[0].closed).toContainEqual([1000, 'connect budget expired']);
    sockets[0].open();
    expect(sockets[0].closed).toContainEqual([1000, 'HTTP fallback selected']);
  });

  it.each([
    'open',
    'decline',
  ] as const)('orders close behind an HTTP-first write when the socket ends in %s', async (outcome) => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    let releaseHttp: (() => void) | undefined;
    const httpPending = new Promise<void>((resolve) => {
      releaseHttp = resolve;
    });
    const { session, writeHttp, closeHttp } = makeSession();
    writeHttp.mockImplementationOnce(async () => httpPending);
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(writeHttp).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const closing = session.close();
    if (outcome === 'open') {
      sockets[0].open();
    } else {
      sockets[0].emit('unexpected-response', {}, {});
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets[0].sent).toHaveLength(0);
    expect(closeHttp).not.toHaveBeenCalled();

    releaseHttp?.();
    await writing;
    if (outcome === 'open') {
      await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
      expect((await decodeOne(sockets[0].sent[0])).meta).toMatchObject({
        type: 'close',
      });
      sockets[0].reply(
        encodeFrame({ type: 'close_ack', reqId: 1 }, new Uint8Array())
      );
    }
    await closing;
    expect(closeHttp).toHaveBeenCalledTimes(outcome === 'decline' ? 1 : 0);
  });

  it('never sends later work over WS after an HTTP-first write fails', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    let rejectHttp: ((error: Error) => void) | undefined;
    const httpPending = new Promise<void>((_resolve, reject) => {
      rejectHttp = reject;
    });
    const { session, writeHttp } = makeSession();
    writeHttp.mockImplementationOnce(async () => httpPending);
    const first = session.write(0, ['one']);
    await vi.waitFor(() => expect(writeHttp).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    const second = session.write(1, ['two']);
    const error = new Error('HTTP outcome unknown');
    rejectHttp?.(error);

    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
    expect(sockets[0].sent).toHaveLength(0);
    expect(writeHttp).toHaveBeenCalledTimes(1);
  });

  it('uses the same bounded decision when close is the first operation', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, closeHttp } = makeSession();
    const closing = session.close();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    expect((await decodeOne(sockets[0].sent[0])).meta).toEqual({
      type: 'close',
      reqId: 1,
    });
    sockets[0].reply(
      encodeFrame({ type: 'close_ack', reqId: 1 }, new Uint8Array())
    );

    await closing;
    expect(closeHttp).not.toHaveBeenCalled();
  });

  it('sends serialized write and close frames after OPEN', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp, closeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    expect(injectTraceContextIntoHeaders).toHaveBeenCalledTimes(1);
    socket.open();

    const writing = session.write(4, ['hi']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const write = await decodeOne(socket.sent[0]);
    expect(write.meta).toEqual({
      type: 'write',
      reqId: 1,
      chunkSeq: 4,
      numChunks: 1,
    });
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await writing;

    const closing = session.close();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect((await decodeOne(socket.sent[1])).meta).toEqual({
      type: 'close',
      reqId: 2,
    });
    socket.reply(
      encodeFrame({ type: 'close_ack', reqId: 2 }, new Uint8Array())
    );
    await vi.waitFor(() =>
      expect(socket.closed).toContainEqual([1000, 'stream closed'])
    );
    socket.emit('close', 1000);
    await closing;

    expect(socket.closed).toContainEqual([1000, 'stream closed']);
    expect(writeHttp).not.toHaveBeenCalled();
    expect(closeHttp).not.toHaveBeenCalled();
  });

  it('splits groups above the v1 request-work limit without resetting sequence', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();

    const chunks = Array.from({ length: 1001 }, () => new Uint8Array([1]));
    const writing = session.write(9, chunks);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect((await decodeOne(socket.sent[0])).meta).toMatchObject({
      chunkSeq: 9,
      numChunks: 1000,
    });
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect((await decodeOne(socket.sent[1])).meta).toMatchObject({
      chunkSeq: 1009,
      numChunks: 1,
    });
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 2 }, new Uint8Array())
    );
    await writing;
  });

  it('falls back to HTTP when frame construction fails before send', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();

    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    await session.write(0, [oversized]);
    await session.write(1, ['later']);

    expect(writeHttp).toHaveBeenCalledTimes(2);
    expect(writeHttp.mock.calls[0]?.[0]?.[0]).toBe(oversized);
    expect(writeHttp.mock.calls[1]).toEqual([['later']]);
    expect(sockets[0].sent).toHaveLength(0);
    expect(sockets[0].closed).toContainEqual([
      1000,
      'HTTP fallback before send',
    ]);
  });

  it('falls back to HTTP when the socket is not open before send', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    socket.readyState = 3;

    await session.write(0, ['one']);
    await session.write(1, ['two']);

    expect(writeHttp.mock.calls).toEqual([[['one']], [['two']]]);
    expect(socket.sent).toHaveLength(0);
  });

  it('poisons a synchronous socket send failure without stale pending work', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    sockets[0].throwOnSend = new Error('sync send failed');

    await expect(session.write(0, ['one'])).rejects.toThrow('sync send failed');
    await expect(session.write(0, ['later'])).rejects.toThrow(
      'sync send failed'
    );
  });

  it('surfaces an uncorrelated server error before poisoning', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp, closeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    socket.reply(
      encodeFrame(
        { type: 'error', status: 401, message: 'token expiring' },
        new Uint8Array()
      )
    );
    await vi.waitFor(() =>
      expect(socket.closed).toContainEqual([
        1011,
        'unknown stream write outcome',
      ])
    );

    await expect(session.write(0, ['later'])).rejects.toThrow(
      'stream WebSocket connection failed (401): token expiring'
    );
    await expect(session.close()).rejects.toThrow('token expiring');
    expect(writeHttp).not.toHaveBeenCalled();
    expect(closeHttp).not.toHaveBeenCalled();
  });

  it.each([
    400, 503,
  ])('poisons a correlated %i write error and prevents queued work', async (status) => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp, closeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();

    const writing = session.write(0, ['one']);
    const queued = session.write(1, ['two']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply(
      encodeFrame(
        {
          type: 'error',
          reqId: 1,
          status,
          message: 'rejected',
          retryAfter: '1',
        },
        new Uint8Array()
      )
    );

    await expect(writing).rejects.toThrow(`(${status}): rejected`);
    await expect(queued).rejects.toThrow(`(${status}): rejected`);
    expect(socket.sent).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    expect(socket.closed).toContainEqual([1011, 'stream request failed']);
    expect(writeHttp).not.toHaveBeenCalled();
    expect(closeHttp).not.toHaveBeenCalled();
    expect(writeSpans[0]).toMatchObject({
      'workflow.stream.ws.session_first_write': true,
      'workflow.stream.ws.send_to_reply_ms': expect.any(Number),
      'workflow.stream.ws.reply_processing_ms': expect.any(Number),
      'workflow.stream.ws.write_total_ms': expect.any(Number),
    });
  });

  it('drains admitted work before reconnecting queued writes', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const firstSocket = sockets[0];
    firstSocket.open();

    const first = session.write(0, ['one']);
    const second = session.write(1, ['two']);
    await vi.waitFor(() => expect(firstSocket.sent).toHaveLength(1));
    firstSocket.reply(
      encodeFrame(
        { type: 'drain', reason: 'max_duration', graceMs: 10_000 },
        new Uint8Array()
      )
    );
    firstSocket.reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await first;
    expect(firstSocket.sent).toHaveLength(1);

    firstSocket.emit('close', 1001);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    const secondSocket = sockets[1];
    expect(new URL(secondSocket.url).searchParams.get('writerId')).toBe(
      writerId
    );
    secondSocket.open();
    await vi.waitFor(() => expect(secondSocket.sent).toHaveLength(1));
    expect((await decodeOne(secondSocket.sent[0])).meta).toMatchObject({
      type: 'write',
      reqId: 2,
      chunkSeq: 1,
    });
    secondSocket.reply(
      encodeFrame({ type: 'write_ack', reqId: 2 }, new Uint8Array())
    );

    await second;
    expect(writeHttp).not.toHaveBeenCalled();
    expect(writeSpans).toHaveLength(2);
    expect(writeSpans[0]).toMatchObject({
      'workflow.stream.ws.session_first_write': true,
      'workflow.stream.ws.connection_first_write': true,
      'workflow.stream.ws.connection_attempt': 1,
    });
    expect(writeSpans[1]).toMatchObject({
      'workflow.stream.ws.session_first_write': false,
      'workflow.stream.ws.connection_first_write': true,
      'workflow.stream.ws.connection_attempt': 2,
    });
    expect(writeSpans[1]['workflow.stream.ws.connect_ms']).toEqual(
      expect.any(Number)
    );
  });

  it('requests fresh auth after an auth-expiry drain', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    getVercelOidcToken.mockResolvedValueOnce('old-token');
    getVercelOidcToken.mockResolvedValueOnce('refreshed-token');
    getVercelOidcToken.mockResolvedValueOnce('refreshed-token');
    const { session, writeHttp } = makeSession({});
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    sockets[0].reply(
      encodeFrame(
        { type: 'drain', reason: 'auth_expiry', graceMs: 10_000 },
        new Uint8Array()
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    sockets[0].emit('close', 1001);

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(getVercelOidcToken).toHaveBeenCalledWith({
      expirationBufferMs: 24 * 60 * 60 * 1000,
    });
    sockets[1].open();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(sockets[1].sent).toHaveLength(1));
    sockets[1].reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await writing;
    expect(writeHttp).not.toHaveBeenCalled();
  });

  it('uses HTTP when auth refresh returns the drained bearer', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    getVercelOidcToken.mockResolvedValue('same-token');
    const { session, writeHttp } = makeSession({});
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    sockets[0].reply(
      encodeFrame(
        { type: 'drain', reason: 'auth_expiry', graceMs: 10_000 },
        new Uint8Array()
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    sockets[0].emit('close', 1001);

    await session.write(0, ['one']);
    expect(sockets).toHaveLength(1);
    expect(writeHttp).toHaveBeenCalledWith(['one']);
  });

  it('forces reconnect when an idle drain outlives its grace', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const firstSocket = sockets[0];
    firstSocket.open();
    firstSocket.reply(
      encodeFrame(
        { type: 'drain', reason: 'max_duration', graceMs: 10 },
        new Uint8Array()
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(firstSocket.closed).toContainEqual([
      1001,
      'stream drain grace expired',
    ]);
    sockets[1].open();
    await vi.waitFor(() => expect(sockets[1].sent).toHaveLength(1));
    sockets[1].reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );

    await writing;
    expect(writeHttp).not.toHaveBeenCalled();
  });

  it('poisons when drain grace expires before an admitted reply', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply(
      encodeFrame(
        { type: 'drain', reason: 'max_duration', graceMs: 1 },
        new Uint8Array()
      )
    );

    await expect(writing).rejects.toThrow('drain expired before request reply');
    await expect(session.write(0, ['one'])).rejects.toThrow(
      'drain expired before request reply'
    );
    expect(writeHttp).not.toHaveBeenCalled();
  });

  it('poisons when drain closes before an admitted reply', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply(
      encodeFrame(
        { type: 'drain', reason: 'max_duration', graceMs: 10_000 },
        new Uint8Array()
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.emit('close', 1001);

    await expect(writing).rejects.toThrow('closed before reply');
    await expect(session.write(0, ['one'])).rejects.toThrow(
      'closed before reply'
    );
    expect(writeHttp).not.toHaveBeenCalled();
  });

  it('bounds idle clean-close reconnects with the same writer id', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    makeSession();
    for (let attempt = 0; attempt < 4; attempt++) {
      await vi.waitFor(() => expect(sockets).toHaveLength(attempt + 1));
      const socket = sockets[attempt];
      expect(new URL(socket.url).searchParams.get('writerId')).toBe(writerId);
      socket.open();
      socket.emit('close', 1001);
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets).toHaveLength(4);
  });

  it('poisons an unknown write outcome and never replays over HTTP', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();

    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.emit('close');

    await expect(writing).rejects.toThrow('closed before reply');
    await expect(session.write(0, ['one'])).rejects.toThrow(
      'closed before reply'
    );
    expect(writeHttp).not.toHaveBeenCalled();
  });

  it('fails a declined writer for good after an HTTP write fails', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp, closeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].emit('unexpected-response', {}, {});
    const error = new Error('Stream write failed: HTTP 503');
    writeHttp.mockRejectedValueOnce(error);

    // Its outcome is unknown, so no later write may apply ahead of a retry of
    // it; core's sink never reaches close() after a failed write either.
    await expect(session.write(0, ['one'])).rejects.toBe(error);
    await expect(session.write(1, ['two'])).rejects.toBe(error);
    await expect(session.close()).rejects.toBe(error);
    expect(writeHttp.mock.calls).toEqual([[['one']]]);
    expect(closeHttp).not.toHaveBeenCalled();
  });

  it('tombstones and cleans up a pre-OPEN decline', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const response = { resume: vi.fn(), destroy: vi.fn() };
    sockets[0].emit('unexpected-response', {}, response);

    await session.write(0, ['one']);
    await session.write(1, ['two']);
    expect(writeHttp.mock.calls).toEqual([[['one']], [['two']]]);
    expect(response.resume).toHaveBeenCalledTimes(1);
    expect(response.destroy).toHaveBeenCalledTimes(1);
    expect(sockets[0].closed).toContainEqual([1000, 'upgrade declined']);
    expect(sockets).toHaveLength(1);
  });

  it('disposes the streamer wrapper before its dynamic session materializes', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { createStreamer } = await import('./streamer.js');
    const session = createStreamer({
      token: 'token',
    }).streams.createWriteSession?.('wrun_1', 'stream/1', { writerId });
    await session?.dispose?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets).toHaveLength(0);
  });

  it('keeps streamer-wrapper disposal socket-free before its first write', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { createStreamer } = await import('./streamer.js');
    const session = createStreamer({
      token: 'token',
    }).streams.createWriteSession?.('wrun_1', 'stream/1', { writerId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets).toHaveLength(0);
    await session?.dispose?.();
    expect(sockets).toHaveLength(0);
  });

  it('releases an acknowledged socket without closing the stream or reconnecting', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp, closeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const releasing = session.release?.();
    expect(socket.closed).toHaveLength(0);
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await writing;
    await releasing;
    expect(socket.closed).toContainEqual([1000, 'stream writer released']);
    socket.emit('error', new Error('released socket reset'));
    socket.emit('close', 1000);
    await session.write(1, ['two']);
    expect(writeHttp).toHaveBeenCalledWith(['two']);
    expect(closeHttp).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    await session.close();
    expect(closeHttp).toHaveBeenCalledTimes(1);
  });

  it('retires a provisional upgrade on release, including a late OPEN', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession(undefined, true);
    await session.write(0, ['one']);
    await session.write(1, ['two']);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await session.release?.();
    sockets[0].open();
    await session.write(2, ['three']);
    expect(writeHttp).toHaveBeenCalledTimes(3);
    expect(sockets[0].sent).toHaveLength(0);
    expect(sockets[0].closed).toContainEqual([1000, 'HTTP fallback selected']);
    expect(sockets).toHaveLength(1);
  });

  it('releases an idle draining socket without reconnecting at grace expiry', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    socket.reply(
      encodeFrame(
        { type: 'drain', reason: 'max_duration', graceMs: 10 },
        new Uint8Array()
      )
    );
    // Let the drain frame decode before release retires the connection.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.release?.();
    socket.emit('close', 1001);
    await session.write(0, ['one']);
    expect(writeHttp).toHaveBeenCalledWith(['one']);
    expect(sockets).toHaveLength(1);
  });

  it('writes HTTP immediately after release even if the retired upgrade never settles', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession(undefined, true);
    await session.write(0, ['one']);
    await session.write(1, ['two']);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    vi.useFakeTimers();
    await session.release?.();
    // FakeSocket.close deliberately emits neither close nor error: the old
    // connection decision is still pending, and its 10s timer never advances.
    await session.write(2, ['three']);
    expect(writeHttp).toHaveBeenCalledTimes(3);
    expect(sockets).toHaveLength(1);
    sockets[0].emit('close', 1000);
  });

  it('finishes a queued write behind a drain before releasing its replacement', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    sockets[0].reply(
      encodeFrame(
        { type: 'drain', reason: 'max_duration', graceMs: 10_000 },
        new Uint8Array()
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const writing = session.write(0, ['one']);
    const releasing = session.release?.();
    sockets[0].emit('close', 1001);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    const replacement = sockets[1];
    replacement.open();
    await vi.waitFor(() => expect(replacement.sent).toHaveLength(1));
    expect(replacement.closed).toHaveLength(0);
    replacement.reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await writing;
    await releasing;
    expect(replacement.closed).toContainEqual([1000, 'stream writer released']);
    expect(writeHttp).not.toHaveBeenCalled();
    await session.write(1, ['two']);
    expect(writeHttp).toHaveBeenCalledWith(['two']);
  });

  it('keeps a deferred session socket-free after release and reuse', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession(undefined, true);
    await session.release?.();
    await session.write(0, ['one']);
    await session.write(1, ['two']);
    expect(writeHttp).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(0);
  });

  it('disposes transport without sending protocol close', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, closeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();

    await session.dispose?.();
    expect(sockets[0].sent).toHaveLength(0);
    expect(sockets[0].closed).toContainEqual([1000, 'stream writer disposed']);
    expect(closeHttp).not.toHaveBeenCalled();
  });
});

describe('v1 stream WebSocket throttling', () => {
  async function openSession() {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const session = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    return { ...session, socket };
  }

  function reply(
    socket: InstanceType<typeof FakeWebSocket>,
    meta: Record<string, unknown>
  ): void {
    socket.reply(encodeFrame(meta, new Uint8Array()));
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('resends a throttled write on the same socket after retryAfter', async () => {
    const { session, socket, writeHttp } = await openSession();
    const writing = session.write(3, ['one']);
    const queued = session.write(4, ['two']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    vi.useFakeTimers();
    reply(socket, {
      type: 'error',
      reqId: 1,
      status: 429,
      message: 'Too many requests',
      retryAfter: '2',
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(socket.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent).toHaveLength(2);
    const original = await decodeOne(socket.sent[0]);
    const resent = await decodeOne(socket.sent[1]);
    expect(resent.meta).toEqual({
      type: 'write',
      reqId: 2,
      chunkSeq: 3,
      numChunks: 1,
    });
    expect(resent.body).toEqual(original.body);

    reply(socket, { type: 'write_ack', reqId: 2 });
    await writing;
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    expect((await decodeOne(socket.sent[2])).meta).toMatchObject({
      reqId: 3,
      chunkSeq: 4,
    });
    reply(socket, { type: 'write_ack', reqId: 3 });
    await queued;

    expect(writeHttp).not.toHaveBeenCalled();
    expect(socket.closed).toEqual([]);
    expect(sockets).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Throttled (429) writing stream chunks')
    );
  });

  it('backs off when a throttled write carries no retryAfter', async () => {
    const { session, socket } = await openSession();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    vi.useFakeTimers();
    reply(socket, { type: 'error', reqId: 1, status: 429 });
    await vi.advanceTimersByTimeAsync(999);
    expect(socket.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent).toHaveLength(2);
    reply(socket, { type: 'write_ack', reqId: 2 });
    await writing;
  });

  it('completes a throttled write over HTTP when the server then closes', async () => {
    const { session, socket, writeHttp } = await openSession();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    vi.useFakeTimers();
    // Servers before the retryable-rejection contract end the connection
    // after every correlated error.
    reply(socket, { type: 'error', reqId: 1, status: 429, retryAfter: '1' });
    socket.emit('close', 1011);
    await vi.advanceTimersByTimeAsync(1_000);
    await writing;
    await session.write(1, ['two']);

    expect(socket.sent).toHaveLength(1);
    expect(writeHttp.mock.calls).toEqual([[['one']], [['two']]]);
    expect(sockets).toHaveLength(1);
  });

  it('fails queued work when a throttled write then fails over HTTP', async () => {
    const { session, socket, writeHttp } = await openSession();
    const error = new Error('HTTP outcome unknown');
    writeHttp.mockRejectedValueOnce(error);
    const writing = session.write(0, ['one']);
    const queued = session.write(1, ['two']);
    const failed = Promise.all([
      expect(writing).rejects.toBe(error),
      expect(queued).rejects.toBe(error),
    ]);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    vi.useFakeTimers();
    reply(socket, { type: 'error', reqId: 1, status: 429, retryAfter: '1' });
    socket.emit('close', 1011);
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;

    expect(writeHttp.mock.calls).toEqual([[['one']]]);
    expect(socket.sent).toHaveLength(1);
  });

  it('settles a throttled write promptly when disposed during the wait', async () => {
    const { session, socket } = await openSession();
    const writing = session.write(0, ['one']);
    const queued = session.write(1, ['two']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    vi.useFakeTimers();
    reply(socket, { type: 'error', reqId: 1, status: 429, retryAfter: '30' });
    await vi.advanceTimersByTimeAsync(0);
    session.dispose?.();

    await expect(writing).rejects.toThrow('stream writer is closed');
    await expect(queued).rejects.toThrow('stream writer is closed');
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.sent).toHaveLength(1);
  });

  it('fails a throttled write promptly when the connection fails during the wait', async () => {
    const { session, socket } = await openSession();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    vi.useFakeTimers();
    reply(socket, { type: 'error', reqId: 1, status: 429, retryAfter: '30' });
    await vi.advanceTimersByTimeAsync(0);
    reply(socket, { type: 'error', status: 401, message: 'token expired' });

    await expect(writing).rejects.toThrow(
      'stream WebSocket connection failed (401): token expired'
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.sent).toHaveLength(1);
  });

  it('hands a write to HTTP once throttling outlasts the retry budget', async () => {
    const { session, socket, writeHttp } = await openSession();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    vi.useFakeTimers();
    reply(socket, {
      type: 'error',
      reqId: 1,
      status: 429,
      message: 'slow down',
      retryAfter: '20',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.sent).toHaveLength(2);
    reply(socket, {
      type: 'error',
      reqId: 2,
      status: 429,
      message: 'slow down',
      retryAfter: '20',
    });
    await writing;
    await session.write(1, ['two']);

    expect(socket.sent).toHaveLength(2);
    expect(socket.closed).toContainEqual([1000, 'stream request throttled']);
    expect(writeHttp.mock.calls).toEqual([[['one']], [['two']]]);
    expect(sockets).toHaveLength(1);
  });

  it('hands a write to HTTP when retryAfter alone exceeds the budget, even after close', async () => {
    const { session, socket, writeHttp } = await openSession();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    reply(socket, { type: 'error', reqId: 1, status: 429, retryAfter: '60' });
    socket.emit('close', 1011);
    await writing;

    expect(socket.sent).toHaveLength(1);
    expect(writeHttp.mock.calls).toEqual([[['one']]]);
  });

  it('reconnects through a drain that arrives during the wait', async () => {
    const { session, socket, writeHttp } = await openSession();
    const writing = session.write(3, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    vi.useFakeTimers();
    reply(socket, { type: 'error', reqId: 1, status: 429, retryAfter: '1' });
    reply(socket, { type: 'drain', reason: 'max_duration', graceMs: 10_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    // Parked behind the drain: nothing is resent on the draining socket.
    expect(socket.sent).toHaveLength(1);

    socket.emit('close', 1001);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    const next = sockets[1];
    next.open();
    await vi.waitFor(() => expect(next.sent).toHaveLength(1));
    expect((await decodeOne(next.sent[0])).meta).toEqual({
      type: 'write',
      reqId: 2,
      chunkSeq: 3,
      numChunks: 1,
    });
    reply(next, { type: 'write_ack', reqId: 2 });
    await writing;

    expect(writeHttp).not.toHaveBeenCalled();
    expect(socket.closed).toEqual([]);
  });

  it('falls back to HTTP when the socket resets during the wait', async () => {
    const { session, socket, writeHttp } = await openSession();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    vi.useFakeTimers();
    reply(socket, { type: 'error', reqId: 1, status: 429, retryAfter: '1' });
    socket.emit(
      'error',
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    );
    socket.emit('close', 1006);
    await vi.advanceTimersByTimeAsync(1_000);
    await writing;
    await session.write(1, ['two']);

    expect(socket.sent).toHaveLength(1);
    expect(writeHttp.mock.calls).toEqual([[['one']], [['two']]]);
    expect(sockets).toHaveLength(1);
  });

  it('resends a throttled close', async () => {
    const { session, socket, closeHttp } = await openSession();
    const closing = session.close();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    vi.useFakeTimers();
    reply(socket, { type: 'error', reqId: 1, status: 429, retryAfter: '1' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await decodeOne(socket.sent[1])).meta).toEqual({
      type: 'close',
      reqId: 2,
    });
    reply(socket, { type: 'close_ack', reqId: 2 });
    await closing;
    expect(closeHttp).not.toHaveBeenCalled();
  });

  it('retries a close 5xx over HTTP', async () => {
    const { session, socket, closeHttp } = await openSession();
    const closing = session.close();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    reply(socket, {
      type: 'error',
      reqId: 1,
      status: 503,
      message: 'close barrier pending',
    });
    socket.emit('close', 1011);
    await closing;

    expect(closeHttp).toHaveBeenCalledTimes(1);
    expect(socket.closed).toContainEqual([
      1000,
      'stream close retried over HTTP',
    ]);
    expect(sockets).toHaveLength(1);
    await expect(session.write(0, ['late'])).rejects.toThrow(
      'stream writer is closed'
    );
  });

  it('keeps a close 4xx terminal', async () => {
    const { session, socket, closeHttp } = await openSession();
    const closing = session.close();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    reply(socket, { type: 'error', reqId: 1, status: 409, message: 'nope' });
    await expect(closing).rejects.toThrow('(409): nope');
    expect(closeHttp).not.toHaveBeenCalled();
  });

  it('keeps a connection-level 429 fatal', async () => {
    const { session, socket, writeHttp } = await openSession();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    reply(socket, { type: 'error', status: 429, message: 'too many pending' });
    await expect(writing).rejects.toThrow(
      'stream WebSocket connection failed (429): too many pending'
    );
    expect(writeHttp).not.toHaveBeenCalled();
  });
});

function decodeChunks(body: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  for (let offset = 0; offset < body.byteLength; ) {
    const length = view.getUint32(offset, false);
    offset += 4;
    chunks.push(body.slice(offset, offset + length));
    offset += length;
  }
  return chunks;
}

async function openSession() {
  process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
  const created = makeSession();
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0];
  socket.open();
  return { ...created, socket };
}

/** Acks each write as it arrives, returning the decoded requests in order. */
async function ackWrites(
  socket: InstanceType<typeof FakeWebSocket>,
  writing: Promise<void>,
  count: number
) {
  const frames = [];
  for (let index = 0; index < count; index++) {
    await vi.waitFor(() => expect(socket.sent).toHaveLength(index + 1));
    const frame = await decodeOne(socket.sent[index]);
    frames.push(frame);
    socket.reply(
      encodeFrame(
        { type: 'write_ack', reqId: frame.meta.reqId },
        new Uint8Array()
      )
    );
  }
  await writing;
  expect(socket.sent).toHaveLength(count);
  return frames;
}

describe('v1 stream WebSocket message byte budget', () => {
  // The shared WORKFLOW_WS_MAX_MESSAGE_BYTES floor, 2 MiB. With the
  // 128-byte envelope bound, two of these chunks fit one message and three
  // do not.
  const LIMIT = MIN_WS_MAX_MESSAGE_BYTES;
  const CHUNK = 800_000;
  const fill = (length: number, size: number) =>
    Array.from({ length }, (_, index) => new Uint8Array(size).fill(index + 1));

  it('splits a group over the budget into contiguous ordered requests', async () => {
    process.env.WORKFLOW_WS_MAX_MESSAGE_BYTES = String(LIMIT);
    const { session, socket, writeHttp } = await openSession();
    const chunks = fill(5, CHUNK);

    const frames = await ackWrites(socket, session.write(7, chunks), 3);

    expect(frames.map((frame) => frame.meta)).toEqual([
      { type: 'write', reqId: 1, chunkSeq: 7, numChunks: 2 },
      { type: 'write', reqId: 2, chunkSeq: 9, numChunks: 2 },
      { type: 'write', reqId: 3, chunkSeq: 11, numChunks: 1 },
    ]);
    for (const raw of socket.sent) {
      expect(raw.byteLength).toBeLessThanOrEqual(LIMIT);
    }
    const sent = frames.flatMap((frame) => decodeChunks(frame.body));
    expect(sent).toHaveLength(chunks.length);
    sent.forEach((chunk, index) => {
      expect(sameBytes(chunk, chunks[index])).toBe(true);
    });
    expect(writeHttp).not.toHaveBeenCalled();
  });

  it('keeps a group under the default budget as one request', async () => {
    const { session, socket } = await openSession();
    const chunks = [
      new Uint8Array(5 * 1024 * 1024),
      new Uint8Array(5 * 1024 * 1024),
      'tail',
    ];

    const frames = await ackWrites(socket, session.write(0, chunks), 1);

    expect(frames[0].meta).toMatchObject({ chunkSeq: 0, numChunks: 3 });
  });

  it('splits few large chunks by bytes at the default budget', async () => {
    const { session, socket } = await openSession();
    const chunks = fill(3, 5 * 1024 * 1024);

    const frames = await ackWrites(socket, session.write(4, chunks), 2);

    expect(frames.map((frame) => frame.meta)).toMatchObject([
      { chunkSeq: 4, numChunks: 2 },
      { chunkSeq: 6, numChunks: 1 },
    ]);
    for (const raw of socket.sent) {
      expect(raw.byteLength).toBeLessThanOrEqual(DEFAULT_WS_MAX_MESSAGE_BYTES);
    }
  });

  it.each([
    { chunkBytes: 1, expected: [1000, 1] },
    { chunkBytes: 4096, expected: [511, 490] },
  ])('applies whichever bound binds first for 1001 chunks of $chunkBytes bytes', async ({
    chunkBytes,
    expected,
  }) => {
    process.env.WORKFLOW_WS_MAX_MESSAGE_BYTES = String(LIMIT);
    const { session, socket } = await openSession();
    const chunks = fill(1001, chunkBytes);

    const frames = await ackWrites(
      socket,
      session.write(0, chunks),
      expected.length
    );

    expect(frames.map((frame) => frame.meta.numChunks)).toEqual(expected);
    expect(frames.map((frame) => frame.meta.chunkSeq)).toEqual([
      0,
      expected[0],
    ]);
    for (const raw of socket.sent) {
      expect(raw.byteLength).toBeLessThanOrEqual(LIMIT);
    }
  });

  it('sends a chunk too large for one message over HTTP without poisoning', async () => {
    process.env.WORKFLOW_WS_MAX_MESSAGE_BYTES = String(LIMIT);
    const { session, socket, writeHttp } = await openSession();
    const big = new Uint8Array(3 * 1024 * 1024);

    await ackWrites(socket, session.write(0, ['head', big, 'tail']), 1);
    await session.write(3, ['later']);

    expect((await decodeOne(socket.sent[0])).meta).toMatchObject({
      chunkSeq: 0,
      numChunks: 1,
    });
    expect(writeHttp).toHaveBeenCalledTimes(2);
    const [fallback] = writeHttp.mock.calls[0];
    expect(fallback).toHaveLength(2);
    expect(fallback[0]).toBe(big);
    expect(fallback[1]).toBe('tail');
    expect(writeHttp.mock.calls[1]).toEqual([['later']]);
    expect(socket.closed).toContainEqual([1000, 'HTTP fallback before send']);
  });

  // Planned at 2 * LIMIT, where two of these chunks share a message; lowering
  // the limit to LIMIT during the wait would make that message too large.
  const THROTTLE_CHUNK = 1_600_000;

  it('resends only a throttled byte-split request, with its planned budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.WORKFLOW_WS_MAX_MESSAGE_BYTES = String(2 * LIMIT);
    const { session, socket, writeHttp } = await openSession();
    const chunks = fill(5, THROTTLE_CHUNK);
    const writing = session.write(7, chunks);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));

    vi.useFakeTimers();
    socket.reply(
      encodeFrame(
        { type: 'error', reqId: 2, status: 429, retryAfter: '1' },
        new Uint8Array()
      )
    );
    // The resend keeps the limit its group was split with.
    process.env.WORKFLOW_WS_MAX_MESSAGE_BYTES = String(LIMIT);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.sent).toHaveLength(3);
    expect(socket.sent[2].byteLength).toBeGreaterThan(LIMIT);
    const original = await decodeOne(socket.sent[1]);
    const resent = await decodeOne(socket.sent[2]);
    expect(resent.meta).toEqual({
      type: 'write',
      reqId: 3,
      chunkSeq: 9,
      numChunks: 2,
    });
    expect(sameBytes(resent.body, original.body)).toBe(true);
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 3 }, new Uint8Array())
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(4));
    expect((await decodeOne(socket.sent[3])).meta).toMatchObject({
      reqId: 4,
      chunkSeq: 11,
      numChunks: 1,
    });
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 4 }, new Uint8Array())
    );
    await writing;

    expect(writeHttp).not.toHaveBeenCalled();
  });

  it('sends only the unapplied tail to HTTP once a byte-split request exhausts the throttle budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.WORKFLOW_WS_MAX_MESSAGE_BYTES = String(LIMIT);
    const { session, socket, writeHttp } = await openSession();
    const chunks = fill(5, CHUNK);
    const writing = session.write(7, chunks);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));

    vi.useFakeTimers();
    const throttle = (reqId: number) =>
      socket.reply(
        encodeFrame(
          { type: 'error', reqId, status: 429, retryAfter: '20' },
          new Uint8Array()
        )
      );
    throttle(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.sent).toHaveLength(3);
    throttle(3);
    await writing;

    expect(socket.sent).toHaveLength(3);
    expect(writeHttp).toHaveBeenCalledTimes(1);
    const [tail] = writeHttp.mock.calls[0];
    expect(tail).toHaveLength(3);
    tail.forEach((chunk, index) => {
      expect(chunk).toBe(chunks[index + 2]);
    });
    expect(socket.closed).toContainEqual([1000, 'stream request throttled']);
  });

  it('never passes an encoded message over the budget to the socket', async () => {
    process.env.WORKFLOW_WS_MAX_MESSAGE_BYTES = String(LIMIT);
    const { session, socket, writeHttp } = await openSession();
    // Simulate a batch plan that underestimates the encoded size.
    batchEndOverride.fn = (chunks) => chunks.length;
    const chunks = fill(3, CHUNK);

    await session.write(0, chunks);

    expect(socket.sent).toHaveLength(0);
    expect(writeHttp).toHaveBeenCalledTimes(1);
    const [all] = writeHttp.mock.calls[0];
    expect(all).toHaveLength(chunks.length);
    all.forEach((chunk, index) => {
      expect(chunk).toBe(chunks[index]);
    });
    expect(socket.closed).toContainEqual([1000, 'HTTP fallback before send']);
  });
});
