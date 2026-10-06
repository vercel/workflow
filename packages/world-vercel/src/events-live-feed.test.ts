/**
 * The live feed over the events WebSocket: the subscribe frame, delivery of
 * `run_event` pushes in slot order at most once, and teardown (unsubscribe,
 * connection loss, refusal, transport off). `ws` is replaced with a fake the
 * test drives directly, as in `ws-transport.test.ts`.
 */
import { slotToEventId } from '@workflow/world';
import { decode } from 'cbor-x';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  LiveFeedError,
  SUBSCRIBE_FRAME_TYPE,
  subscribeRunEvents,
} from './events-live-feed.js';
import { encodeFrame } from './frames.js';
import { injectTraceContextIntoHeaders } from './telemetry.js';
import {
  getWsEventsTransport,
  RUN_EVENT_FRAME_TYPE,
  resetWsEventsTransportsForTest,
  resolveWsTransport,
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
    readonly sent: Uint8Array[] = [];
    private readonly listeners = new Map<string, Listener[]>();
    constructor(url: string) {
      this.url = url;
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
      this.sent.push(data);
      cb?.();
    }
    close(code = 1000): void {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.CLOSED;
      this.emit('close', code);
    }
    open(): void {
      this.readyState = FakeSocket.OPEN;
      this.emit('open');
    }
    deliver(frame: Uint8Array): void {
      this.emit('message', Buffer.from(frame));
    }
  }
  return { FakeWebSocket: FakeSocket, sockets };
});

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));

const RUN = 'wrun_feed';
const CONFIG = { token: 'test-token' };
const EMPTY = new Uint8Array(0);

const tick = () => vi.advanceTimersByTimeAsync(0);

async function settle(predicate: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`never settled: ${label}`);
}

function sentMetas(socket: { sent: Uint8Array[] }) {
  return socket.sent.map((raw) => {
    const metaLen = new DataView(
      raw.buffer,
      raw.byteOffset,
      raw.byteLength
    ).getUint32(0, false);
    return decode(raw.subarray(4, 4 + metaLen)) as Record<string, unknown>;
  });
}

function pushed(slot: number, runId = RUN) {
  return encodeFrame(
    {
      type: RUN_EVENT_FRAME_TYPE,
      event: {
        eventId: slotToEventId(slot),
        runId,
        eventType: 'hook_received',
        correlationId: 'hook_1',
        createdAt: new Date('2026-10-05T00:00:00.000Z'),
        specVersion: 9,
        eventData: { token: 'tok' },
      },
    },
    new Uint8Array([slot])
  );
}

/** Subscribe and drive the socket until the subscribe frame is on the wire. */
async function subscribed(afterSlot = 2) {
  const events: { eventId: string; payload: unknown }[] = [];
  const onError = vi.fn();
  const unsubscribe = subscribeRunEvents(
    RUN,
    afterSlot,
    (event) =>
      events.push({
        eventId: event.eventId,
        payload: (event.eventData as { payload?: unknown }).payload,
      }),
    { onError },
    CONFIG
  );
  await settle(() => sockets.length > 0, 'socket constructed');
  const socket = sockets[sockets.length - 1];
  socket.open();
  await settle(() => socket.sent.length > 0, 'subscribe frame sent');
  const [meta] = sentMetas(socket);
  return { events, onError, unsubscribe, socket, meta };
}

beforeAll(async () => {
  await injectTraceContextIntoHeaders(new Headers());
});

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  resetWsEventsTransportsForTest();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  resetWsEventsTransportsForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('subscribeRunEvents', () => {
  it('sends a subscribe frame carrying afterSlot', async () => {
    const { meta, socket } = await subscribed(7);
    expect(meta).toMatchObject({ type: SUBSCRIBE_FRAME_TYPE, afterSlot: 7 });
    expect(typeof meta?.reqId).toBe('number');
    expect(socket.url).toContain(`/websockets/v1/runs/${RUN}`);
  });

  it('delivers pushed events in arrival order, each slot once, nothing at or below afterSlot', async () => {
    const { events, onError, socket, meta } = await subscribed(2);
    socket.deliver(
      encodeFrame({ reqId: meta?.reqId, type: 'ack', status: 200 }, EMPTY)
    );
    await tick();
    for (const slot of [2, 3, 4, 4, 3, 5]) socket.deliver(pushed(slot));
    expect(events.map((event) => event.eventId)).toEqual([
      slotToEventId(3),
      slotToEventId(4),
      slotToEventId(5),
    ]);
    // The body is the payload, decoded like a list frame.
    expect(events[0]?.payload).toEqual(new Uint8Array([3]));
    expect(onError).not.toHaveBeenCalled();
  });

  it('drops events for another run', async () => {
    const { events, socket } = await subscribed(2);
    socket.deliver(pushed(3, 'wrun_other'));
    expect(events).toHaveLength(0);
  });

  it('stops delivering the moment unsubscribe returns, and releases the channel', async () => {
    const { events, onError, unsubscribe, socket } = await subscribed(2);
    socket.deliver(pushed(3));
    unsubscribe();
    unsubscribe();
    socket.deliver(pushed(4));
    expect(events.map((event) => event.eventId)).toEqual([slotToEventId(3)]);
    // No other holder, so the socket goes and the channel is de-registered.
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(resolveWsTransport(RUN, CONFIG)).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps a socket another invocation still holds when it unsubscribes', async () => {
    const { unsubscribe, socket } = await subscribed(2);
    const resolved = resolveWsTransport(RUN, CONFIG);
    resolved?.transport.open();
    unsubscribe();
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('reports a connection loss once through onError and delivers nothing after', async () => {
    const { events, onError, socket } = await subscribed(2);
    socket.close(1001);
    socket.deliver(pushed(3));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(LiveFeedError);
    expect(events).toHaveLength(0);
  });

  it('reports a refused subscription through onError', async () => {
    const { onError, socket, meta } = await subscribed(2);
    socket.deliver(
      encodeFrame({ reqId: meta?.reqId, type: 'error', status: 400 }, EMPTY)
    );
    await settle(() => onError.mock.calls.length > 0, 'refusal reported');
    expect(onError).toHaveBeenCalledTimes(1);
    socket.deliver(pushed(3));
  });

  it('does not tear down the connection or its pending writes on a push', async () => {
    const { socket } = await subscribed(2);
    const transport = getWsEventsTransport(socket.url, async () => ({}));
    const write = transport.request((reqId) =>
      encodeFrame({ reqId, type: 'event', event: {} }, EMPTY)
    );
    await tick();
    socket.deliver(pushed(3));
    const writeMeta = sentMetas(socket).at(-1);
    socket.deliver(
      encodeFrame(
        { reqId: writeMeta?.reqId, type: 'event_ack', status: 200 },
        EMPTY
      )
    );
    await expect(write).resolves.toMatchObject({
      meta: { status: 200 },
    });
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('reports, without throwing, when the WS transport is off', async () => {
    vi.stubEnv('WORKFLOW_EVENTS_TRANSPORT', 'http');
    const onError = vi.fn();
    const unsubscribe = subscribeRunEvents(
      RUN,
      0,
      () => {},
      { onError },
      CONFIG
    );
    await tick();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(0);
    unsubscribe();
  });

  it('fails the feed on a malformed push instead of passing it on', async () => {
    const { events, onError, socket } = await subscribed(2);
    socket.deliver(encodeFrame({ type: RUN_EVENT_FRAME_TYPE }, EMPTY));
    expect(onError).toHaveBeenCalledTimes(1);
    socket.deliver(pushed(3));
    expect(events).toHaveLength(0);
  });
});
