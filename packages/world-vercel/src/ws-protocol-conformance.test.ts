/**
 * Wire-contract conformance for the WS events protocol.
 *
 * `ws-transport.test.ts` drives the client against a socket that replies with
 * whatever the test hands it, which proves the transport's lifecycle but not
 * that the bytes it emits are the bytes workflow-server accepts — a client and
 * server can each pass their own suites while disagreeing on the envelope.
 *
 * So this file pairs the real client stack (including
 * `createWorkflowRunEventV4`) with a fixture mirroring what the server route
 * does per message: decode one frame, validate the meta against a local copy of
 * `WsRequestFrameSchema`, dispatch, and encode the reply the way the route's
 * `replyMeta` builder does. Only the socket is faked, since
 * `experimental_upgradeWebSocket` needs a real Vercel runtime.
 *
 * That schema copy is the one thing here that can drift from the server. The
 * golden-byte fixtures are the backstop: they pin the encoding, so a one-sided
 * envelope change fails `encodes a known request frame to stable bytes`. The
 * matching half of this interop test still needs to land in workflow-server.
 */

import { EntityConflictError } from '@workflow/errors';
import { decode, encode } from 'cbor-x';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createWorkflowRunEventV4 } from './events-v4.js';
import { type DecodedFrame, decodeFrames, encodeFrame } from './frames.js';

// ---------------------------------------------------------------------------
// Mirror of workflow-server's lib/handlers/v4/frames.ts
// ---------------------------------------------------------------------------

const WsRequestFrameSchema = z.discriminatedUnion('type', [
  z.object({
    reqId: z.number(),
    type: z.literal('event'),
    event: z.object({}).passthrough(),
  }),
]);

/** Reserved reqId the server replies under for an unparseable frame. */
const MALFORMED_FRAME_REQ_ID = -1;

/** What the server route does to one inbound message, minus the transport. */
interface RouteResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

const { FakeWebSocket, sockets } = vi.hoisted(() => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static readonly OPEN = 1;
    readyState = 0;
    binaryType = '';
    /** Set by the test: how the fixture server answers a dispatched event. */
    respond: (eventMeta: Record<string, unknown>, body: Uint8Array) => unknown =
      () => ({ status: 201 });
    /** Every raw frame the client put on the wire. */
    readonly sent: Uint8Array[] = [];
    private readonly listeners = new Map<
      string,
      Array<(...a: unknown[]) => void>
    >();

    /** Set by the fixture server: called with each frame the client sends. */
    onFrame: ((raw: Uint8Array) => void) | null = null;

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
    send(data: Uint8Array, cb?: (err?: Error) => void): void {
      this.sent.push(data);
      cb?.();
      this.onFrame?.(data);
    }
    close(code = 1000): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close', code);
    }
    open(): void {
      this.readyState = 1;
      this.emit('open');
    }
    deliver(frame: Uint8Array): void {
      this.emit('message', Buffer.from(frame));
    }
  }
  return { FakeWebSocket: FakeSocket, sockets };
});

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));

const { openWsChannel, resetWsEventsTransportsForTest } = await import(
  './ws-transport.js'
);

/** Decode exactly one frame, the way the server's `decodeFrame` does. */
async function decodeOne(raw: Uint8Array): Promise<DecodedFrame> {
  for await (const frame of decodeFrames(
    (async function* () {
      yield raw;
    })()
  )) {
    return frame;
  }
  throw new Error('empty frame');
}

function encodeErrorFrame(
  reqId: number,
  status: number,
  message: string
): Uint8Array {
  return encodeFrame(
    { reqId, type: 'error', status },
    new TextEncoder().encode(JSON.stringify({ message }))
  );
}

/**
 * Mirrors the route's `replyMeta` construction: status, plus the handful of
 * `x-wf-*` response headers flattened onto the frame meta.
 */
function buildReplyMeta(
  reqId: number,
  res: RouteResponse
): Record<string, unknown> {
  const h = res.headers ?? {};
  const byHeader: Array<[string, string]> = [
    ['x-wf-event-id', 'eventId'],
    ['x-wf-run-id', 'runId'],
    ['x-wf-created-at', 'createdAt'],
    ['retry-after', 'retryAfter'],
  ];
  const meta: Record<string, unknown> = {
    reqId,
    type: 'event_ack',
    status: res.status,
  };
  for (const [header, key] of byHeader) {
    if (h[header]) meta[key] = h[header];
  }
  return meta;
}

/**
 * Wire the fixture "server" to a socket: on every frame the client sends,
 * run the route's message handling and deliver the reply back.
 */
function attachFixtureServer(
  socket: InstanceType<typeof FakeWebSocket>,
  handler: (
    eventMeta: Record<string, unknown>,
    body: Uint8Array
  ) => RouteResponse
) {
  const seen: Array<{ meta: Record<string, unknown>; body: Uint8Array }> = [];
  socket.onFrame = (raw) => {
    void (async () => {
      let frame: DecodedFrame;
      try {
        frame = await decodeOne(raw);
      } catch (err) {
        socket.deliver(
          encodeErrorFrame(
            MALFORMED_FRAME_REQ_ID,
            400,
            `ws v1: malformed frame: ${String(err)}`
          )
        );
        return;
      }

      const parsed = WsRequestFrameSchema.safeParse(frame.meta);
      if (!parsed.success) {
        const rawReqId = (frame.meta as { reqId?: unknown }).reqId;
        socket.deliver(
          encodeErrorFrame(
            typeof rawReqId === 'number' ? rawReqId : MALFORMED_FRAME_REQ_ID,
            400,
            `ws v1 frame: ${parsed.error.message}`
          )
        );
        return;
      }

      seen.push({ meta: parsed.data.event, body: frame.body });
      const res = handler(parsed.data.event, frame.body);
      socket.deliver(
        encodeFrame(
          buildReplyMeta(parsed.data.reqId, res),
          res.body ?? new Uint8Array(0)
        )
      );
    })();
  };
  return seen;
}

const CREATED_AT = '2026-06-10T00:00:00.000Z';

const okHeaders = {
  'x-wf-event-id': 'evnt_1',
  'x-wf-run-id': 'wrun_1',
  'x-wf-created-at': CREATED_AT,
};

/** The materialized CBOR body a `step_completed` write answers with. The ids
 *  the caller sees come out of this body, not the reply meta. */
const materializedBody = (eventId = 'evnt_1') =>
  new Uint8Array(
    encode({
      event: {
        eventId,
        runId: 'wrun_1',
        createdAt: CREATED_AT,
        eventType: 'step_completed',
        specVersion: 2,
        correlationId: 'step_1',
        eventData: { result: new Uint8Array() },
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
    })
  );

const input = {
  runId: 'wrun_1',
  eventType: 'step_completed',
  specVersion: 2,
  correlationId: 'step_1',
  payload: new TextEncoder().encode('"result"'),
} as const;

beforeEach(() => {
  sockets.length = 0;
  resetWsEventsTransportsForTest();
  process.env.WORKFLOW_EVENTS_TRANSPORT = 'ws';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.WORKFLOW_EVENTS_TRANSPORT;
  vi.restoreAllMocks();
});

/**
 * Kick off a real `createWorkflowRunEventV4`, attach the fixture server to
 * the socket the transport opens, then let the handshake complete.
 */
async function callThroughFixture(
  handler: (
    eventMeta: Record<string, unknown>,
    body: Uint8Array
  ) => RouteResponse
) {
  // Stand in for the flow route: without an open channel the write resolves
  // none and goes over HTTP, which is the whole point of the explicit pair.
  openWsChannel(input.runId, { token: 'test-token' });
  // Let the transport construct its socket (it awaits the header thunk), and
  // finish the handshake *before* issuing the write. The write path only takes
  // the socket once it is genuinely open — a frame issued mid-connect resolves
  // no transport and goes over HTTP, which would leave this fixture asserting
  // on a socket nothing was ever sent through.
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  const socket = sockets[0];
  const seen = attachFixtureServer(socket, handler);
  socket.open();
  const pending = createWorkflowRunEventV4(input, { token: 'test-token' });
  void pending.catch(() => {});
  return { pending, socket, seen };
}

describe('client → server frame shape', () => {
  it('emits a frame the server schema accepts, with meta nested under `event`', async () => {
    const { pending, seen } = await callThroughFixture(() => ({
      status: 201,
      headers: okHeaders,
      body: materializedBody(),
    }));

    const result = await pending;

    // Round-trip succeeded, which already means the schema validated —
    // a flat frame would have come back as a 400 error frame instead.
    expect(result.event.eventId).toBe('evnt_1');
    expect(result.step).toMatchObject({ stepId: 'step_1' });

    // And the meta the server unpacked is the event meta, not the envelope.
    expect(seen).toHaveLength(1);
    expect(seen[0].meta).toMatchObject({
      eventType: 'step_completed',
      specVersion: 2,
      correlationId: 'step_1',
    });
    expect(seen[0].meta.reqId).toBeUndefined();
    expect(seen[0].meta.type).toBeUndefined();
    // runId rides the connection URL, never the frame.
    expect(seen[0].meta.runId).toBeUndefined();
  });

  it('sends the payload through untouched as the frame body', async () => {
    const { pending, seen } = await callThroughFixture(() => ({
      status: 201,
      headers: okHeaders,
      body: materializedBody(),
    }));
    await pending;

    expect(new TextDecoder().decode(seen[0].body)).toBe('"result"');
  });

  it('puts exactly one frame in each socket message (no trailing bytes)', async () => {
    // The server rejects trailing bytes past the declared body as a client
    // framing bug, so a message must be byte-exact.
    const { pending, socket } = await callThroughFixture(() => ({
      status: 201,
      headers: okHeaders,
      body: materializedBody(),
    }));
    await pending;

    const raw = socket.sent[0];
    const metaLen = new DataView(
      raw.buffer,
      raw.byteOffset,
      raw.byteLength
    ).getUint32(0, false);
    const bodyLen = new DataView(
      raw.buffer,
      raw.byteOffset,
      raw.byteLength
    ).getUint32(4 + metaLen, false);
    expect(raw.byteLength).toBe(4 + metaLen + 4 + bodyLen);
  });
});

describe('server → client reply handling', () => {
  it('surfaces a non-2xx ack as the same typed error the HTTP path raises', async () => {
    const { pending } = await callThroughFixture(() => ({
      status: 409,
      body: new TextEncoder().encode('{"message":"already applied"}'),
    }));

    // Same class the HTTP path raises for a 409, so the runtime's
    // "already applied, drop it" branch fires identically on either
    // transport — that equivalence is the whole point of the WS adapter.
    await expect(pending).rejects.toThrow(EntityConflictError);
    await expect(pending).rejects.toThrow(/already applied/);
  });

  it('fails closed on a reply variant this client version does not know', async () => {
    const { pending, socket } = await callThroughFixture(() => ({
      status: 201,
      headers: okHeaders,
    }));
    // Pre-empt the fixture's ack with a future reply type carrying no status.
    socket.onFrame = (raw) => {
      void decodeOne(raw).then((f) =>
        socket.deliver(
          encodeFrame(
            { reqId: f.meta.reqId, type: 'event_ack_v2' },
            new Uint8Array(0)
          )
        )
      );
    };

    await expect(pending).rejects.toThrow(/no numeric status/);
  });

  it('correlates replies by reqId across concurrent writes on one socket', async () => {
    let n = 0;
    const { pending, socket } = await callThroughFixture(() => {
      n++;
      return {
        status: 201,
        headers: { ...okHeaders, 'x-wf-event-id': `evnt_${n}` },
        body: materializedBody(`evnt_${n}`),
      };
    });
    const second = createWorkflowRunEventV4(
      { ...input, correlationId: 'step_2' },
      { token: 'test-token' }
    );

    const [a, b] = await Promise.all([pending, second]);
    expect(new Set([a.event.eventId, b.event.eventId])).toEqual(
      new Set(['evnt_1', 'evnt_2'])
    );
    expect(socket.sent).toHaveLength(2);
  });
});

describe('golden frames', () => {
  // Hand-computed from the format in the spec:
  //   frame := u32_be(meta_len) || cbor_meta || u32_be(body_len) || body
  // If this changes, the server's decoder must change with it — that's the
  // point of pinning bytes rather than re-deriving them with encodeFrame.
  const GOLDEN_META = { reqId: 1, type: 'event', event: { eventType: 'x' } };
  const GOLDEN_BODY = new TextEncoder().encode('hi');

  //   0000002a                      meta_len = 42
  //   b900 03 ...                    CBOR map: reqId/type/event
  //   00000002                       body_len = 2
  //   6869                           "hi"
  const GOLDEN_HEX =
    '0000002a' +
    'b90003657265714964016474797065656576656e74656576656e74b90001696576656e7454797065617' +
    '8' +
    '00000002' +
    '6869';

  it('encodes a known request frame to stable bytes', () => {
    const frame = encodeFrame(GOLDEN_META, GOLDEN_BODY);
    expect(Buffer.from(frame).toString('hex')).toBe(GOLDEN_HEX);
  });

  it('decodes the golden bytes back to the golden frame', async () => {
    const decoded = await decodeOne(
      new Uint8Array(Buffer.from(GOLDEN_HEX, 'hex'))
    );
    expect(decoded.meta).toEqual(GOLDEN_META);
    expect(new TextDecoder().decode(decoded.body)).toBe('hi');
  });

  it('round-trips through the shared decoder', async () => {
    const frame = encodeFrame(GOLDEN_META, GOLDEN_BODY);
    const decoded = await decodeOne(frame);
    expect(decoded.meta).toEqual(GOLDEN_META);
    expect(new TextDecoder().decode(decoded.body)).toBe('hi');
  });

  it('is accepted by the server request schema', () => {
    expect(WsRequestFrameSchema.safeParse(GOLDEN_META).success).toBe(true);
  });

  it('rejects the flat shape that caused the original drift', () => {
    // The bug the spec doc exists to prevent: event meta hoisted onto the
    // frame instead of nested under `event`.
    const flat = { reqId: 1, type: 'event', eventType: 'x', specVersion: 2 };
    expect(WsRequestFrameSchema.safeParse(flat).success).toBe(false);
  });

  it('decodes a golden event_ack the way the client expects', async () => {
    const ack = encodeFrame(
      {
        reqId: 1,
        type: 'event_ack',
        status: 201,
        eventId: 'evnt_1',
        runId: 'wrun_1',
        createdAt: '2026-06-10T00:00:00.000Z',
      },
      new Uint8Array(encode({ ok: true }))
    );
    const decoded = await decodeOne(ack);
    expect(decoded.meta).toMatchObject({ type: 'event_ack', status: 201 });
    expect(decode(decoded.body)).toEqual({ ok: true });
  });
});
