/**
 * Unit coverage for the WS events transport's failure and lifecycle paths.
 *
 * These are the parts that are effectively unreachable from the e2e suite:
 * they need a socket to break at a specific moment (a send that fails
 * mid-flight, an error after open, a superseded socket closing late), which
 * a live deployment won't reproduce on demand. The happy path is already
 * covered end-to-end by the `e2e-vercel-ws-transport` jobs, so the emphasis
 * here is "nothing hangs and nothing is silent".
 *
 * `ws` is replaced with a fake we can drive directly — the real one needs a
 * live server to reach `'open'`. Fake timers throughout so the reconnect
 * backoff is deterministic and a microtask flush is a single `tick()`.
 */

import { decode } from 'cbor-x';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame } from './frames.js';
import {
  getWsEventsTransport,
  resetWsEventsTransportsForTest,
  toEventsWsUrl,
} from './ws-transport.js';

type Listener = (...args: unknown[]) => void;

const { FakeWebSocket, sockets } = vi.hoisted(() => {
  const sockets: FakeSocket[] = [];

  class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = 0;
    binaryType = '';
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly sent: Uint8Array[] = [];
    /** Queued failures for upcoming `send` calls. */
    readonly sendErrors: Error[] = [];
    private readonly listeners = new Map<string, Listener[]>();

    constructor(url: string, options?: { headers?: Record<string, string> }) {
      this.url = url;
      this.headers = options?.headers ?? {};
      sockets.push(this);
    }

    on(event: string, cb: Listener): this {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args);
    }

    send(data: Uint8Array, cb?: (err?: Error) => void): void {
      const err = this.sendErrors.shift();
      if (err) {
        cb?.(err);
        return;
      }
      this.sent.push(data);
      cb?.();
    }

    close(code = 1000): void {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.CLOSED;
      this.emit('close', code);
    }

    // ---- test drivers ----

    /** Complete the handshake. */
    open(): void {
      this.readyState = FakeSocket.OPEN;
      this.emit('open');
    }

    /** Fail the handshake the way `ws` does: 'error', then 'close'. */
    failHandshake(err = new Error('ECONNREFUSED')): void {
      this.emit('error', err);
      this.close(1006);
    }

    /** An error on an already-open socket (broken pipe, protocol fault). */
    errorAfterOpen(err = new Error('EPIPE')): void {
      this.emit('error', err);
    }

    /**
     * Half-dead: no longer usable for new work (so the transport will open
     * a replacement) but hasn't emitted `'close'` yet — the window in which
     * a superseded socket can still fire a late close.
     */
    stall(): void {
      this.readyState = FakeSocket.CLOSING;
    }

    deliver(frame: Uint8Array): void {
      this.emit('message', Buffer.from(frame));
    }
  }

  return { FakeWebSocket: FakeSocket, sockets };
});

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));

const WS_URL = 'wss://vercel-workflow.com/api/websockets/v1/runs/wrun_test';
const EMPTY = new Uint8Array(0);

/** Flush pending microtasks (and any timers due right now). */
const tick = () => vi.advanceTimersByTimeAsync(0);

/** Build a request frame the way `postEventFrameOverWs` does. */
const eventFrame = (reqId: number) =>
  encodeFrame(
    { reqId, type: 'event', event: { eventType: 'run_created' } },
    EMPTY
  );

/** An `event_ack` reply for `reqId`. */
const ackFrame = (reqId: number, status = 201, body = EMPTY) =>
  encodeFrame({ reqId, type: 'event_ack', status }, body);

/** Read the `reqId`s off the frames this transport put on the wire. */
const sentReqIds = (socket: { sent: Uint8Array[] }): unknown[] =>
  socket.sent.map((raw) => {
    const metaLen = new DataView(
      raw.buffer,
      raw.byteOffset,
      raw.byteLength
    ).getUint32(0, false);
    const meta = decode(raw.subarray(4, 4 + metaLen)) as { reqId?: unknown };
    return meta.reqId;
  });

const latest = () => sockets[sockets.length - 1];

/**
 * Start a request and let its socket finish the handshake. The returned
 * promise already has a no-op rejection handler attached so tests that
 * don't assert on it can't trip an unhandled-rejection warning.
 */
async function connectAndSend(
  transport: ReturnType<typeof getWsEventsTransport>
) {
  const promise = transport.request(eventFrame);
  void promise.catch(() => {});
  await tick();
  const socket = latest();
  socket.open();
  await tick();
  return { promise, socket };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  resetWsEventsTransportsForTest();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const headers = async () => ({ authorization: 'Bearer token-1' });

const loggedErrors = () =>
  errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');

describe('toEventsWsUrl', () => {
  it('upgrades the scheme and scopes the path to one run', () => {
    expect(toEventsWsUrl('https://vercel-workflow.com/api', 'wrun_abc')).toBe(
      'wss://vercel-workflow.com/api/websockets/v1/runs/wrun_abc'
    );
  });

  it('uses ws: for a plaintext base URL and encodes the runId', () => {
    expect(toEventsWsUrl('http://localhost:3000/api/', 'a/b')).toBe(
      'ws://localhost:3000/api/websockets/v1/runs/a%2Fb'
    );
  });
});

describe('request/reply', () => {
  it('resolves a request with the reply frame matched by reqId', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);
    expect(socket.sent).toHaveLength(1);

    socket.deliver(ackFrame(1, 201, new Uint8Array([1, 2])));
    await tick();

    await expect(promise).resolves.toMatchObject({
      meta: { reqId: 1, type: 'event_ack', status: 201 },
      body: new Uint8Array([1, 2]),
    });
  });

  it('multiplexes concurrent requests and matches each reply to its caller', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise: first, socket } = await connectAndSend(transport);
    const second = transport.request(eventFrame);
    await tick();

    expect(sentReqIds(socket)).toEqual([1, 2]);

    // Replies arrive out of order — correlation is by reqId, not arrival.
    socket.deliver(ackFrame(2, 200));
    socket.deliver(ackFrame(1, 201));
    await tick();

    await expect(second).resolves.toMatchObject({ meta: { reqId: 2 } });
    await expect(first).resolves.toMatchObject({ meta: { reqId: 1 } });
  });
});

describe('per-connection reqId and pending map', () => {
  it('restarts reqId at 1 on a new connection', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);
    socket.deliver(ackFrame(1));
    await tick();
    await promise;

    socket.close(1001);
    await tick();

    const { socket: second } = await connectAndSend(transport);
    // The protocol defines reqId as a per-connection counter; a
    // transport-wide counter would have put 2 on the wire here.
    expect(sentReqIds(second)).toEqual([1]);
  });

  it("a superseded socket's late close cannot reject the live socket's request", async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { socket: first } = await connectAndSend(transport);
    // Take the first socket out of rotation without emitting 'close' yet.
    first.stall();

    const { promise: live, socket: second } = await connectAndSend(transport);
    expect(second).not.toBe(first);

    // The stale socket finally closes. Its reqId 1 is the same id the live
    // socket is waiting on — one shared pending map would reject it here.
    first.close(1006);
    await tick();

    second.deliver(ackFrame(1, 201));
    await tick();
    await expect(live).resolves.toMatchObject({ meta: { reqId: 1 } });
  });

  it('fails the requests riding a socket when it closes', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);

    socket.close(1001);
    await tick();

    await expect(promise).rejects.toThrow(/connection closed \(code 1001\)/);
  });
});

describe('failures are never silent', () => {
  it('rejects the request when send fails instead of hanging', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const promise = transport.request(eventFrame);
    void promise.catch(() => {});
    await tick();
    // `ws.send()` reports a non-OPEN socket through its callback rather
    // than throwing; without that callback wired up, this request would
    // never settle.
    latest().sendErrors.push(new Error('WebSocket is not open'));
    latest().open();
    await tick();

    await expect(promise).rejects.toThrow(/WebSocket is not open/);
  });

  it('logs a post-open socket error and tears the connection down', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);

    socket.errorAfterOpen(new Error('EPIPE'));
    await tick();

    expect(loggedErrors()).toContain('socket error');
    expect(loggedErrors()).toContain('EPIPE');
    // The error handler closes explicitly, so in-flight work fails fast
    // instead of waiting on a dead socket.
    await expect(promise).rejects.toThrow(/connection closed/);
  });

  it('logs an undecodable reply frame', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { socket } = await connectAndSend(transport);

    socket.deliver(new Uint8Array([0, 0, 0]));
    await tick();

    expect(loggedErrors()).toContain('could not decode');
  });

  it('loudly logs the reserved malformed-frame reqId instead of dropping it', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { socket } = await connectAndSend(transport);

    socket.deliver(
      encodeFrame(
        { reqId: -1, type: 'error', status: 400 },
        new TextEncoder().encode(JSON.stringify({ message: 'bad frame' }))
      )
    );
    await tick();

    expect(loggedErrors()).toContain('malformed-frame error');
    // The server's message is surfaced, not just the sentinel id.
    expect(loggedErrors()).toContain('bad frame');
  });

  it('logs a reply that matches no in-flight request', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { socket } = await connectAndSend(transport);

    socket.deliver(ackFrame(999));
    await tick();

    expect(loggedErrors()).toContain('unknown reqId 999');
  });

  it('logs a drain notice without settling in-flight work', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    socket.deliver(encodeFrame({ type: 'drain', graceMs: 10_000 }, EMPTY));
    await tick();

    expect(logSpy.mock.calls.map((a) => a.join(' ')).join('\n')).toContain(
      'drain notice'
    );
    expect(settled).toBe(false);
  });
});

describe('eager reconnect', () => {
  it('reopens the socket after an unexpected close, with no new request', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);

    socket.close(1001);
    await tick();
    await expect(promise).rejects.toThrow();

    // Nothing is asking for a socket — the reconnect runs off its own timer.
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(sockets).toHaveLength(2);
  });

  it('resolves headers again on reconnect so the new socket gets a fresh token', async () => {
    let n = 0;
    const rotating = async () => ({ authorization: `Bearer token-${++n}` });
    const transport = getWsEventsTransport(WS_URL, rotating);

    const { promise, socket } = await connectAndSend(transport);
    expect(socket.headers.authorization).toBe('Bearer token-1');

    socket.close(1006);
    await tick();
    await expect(promise).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(200);
    expect(sockets).toHaveLength(2);
    // The frozen-token problem is per socket: a reconnect must not replay
    // the token the previous socket was opened with.
    expect(sockets[1].headers.authorization).toBe('Bearer token-2');
  });

  it('resolves headers once per socket, not once per request', async () => {
    const getHeaders = vi.fn(async () => ({ authorization: 'Bearer t' }));
    const transport = getWsEventsTransport(WS_URL, getHeaders);

    const { socket } = await connectAndSend(transport);
    void transport.request(eventFrame).catch(() => {});
    void transport.request(eventFrame).catch(() => {});
    await tick();

    expect(socket.sent).toHaveLength(3);
    expect(getHeaders).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt cap and leaves the retry to the next request', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);
    socket.close(1006);
    await tick();
    await expect(promise).rejects.toThrow();

    // Every reconnect attempt now fails its handshake. Backoff is
    // exponential from 100ms, capped at 5s, so 10s per iteration covers
    // each attempt with room to spare.
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      if (latest().readyState === 0) {
        latest().failHandshake();
        await tick();
      }
    }

    // 1 original + at most RECONNECT_MAX_ATTEMPTS reconnect attempts.
    expect(sockets.length).toBeLessThanOrEqual(6);
    expect(loggedErrors()).toContain('giving up eager reconnect');
  });

  it('reconnects lazily on the next request after giving up', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);
    socket.close(1006);
    await tick();
    await expect(promise).rejects.toThrow();

    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      if (latest().readyState === 0) {
        latest().failHandshake();
        await tick();
      }
    }
    const afterGivingUp = sockets.length;

    void transport.request(eventFrame).catch(() => {});
    await tick();

    expect(sockets.length).toBe(afterGivingUp + 1);
  });

  it('does not reconnect when a newer socket is already live', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise: first, socket } = await connectAndSend(transport);

    // Stale socket steps aside and a new one takes over...
    socket.stall();
    const { socket: second } = await connectAndSend(transport);
    expect(second).not.toBe(socket);

    // ...and only now does the stale one emit its close.
    socket.close(1006);
    await tick();
    await expect(first).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(2);
  });
});
