/**
 * The per-write client span on the WebSocket events transport.
 *
 * On HTTP every event write is an `http POST` CLIENT span, opened by
 * `instrumentedFetch`. A frame on a multiplexed socket makes no `fetch` call, so
 * that span vanished when `WORKFLOW_EVENTS_TRANSPORT=ws` was introduced, taking
 * the per-event view of a run with it. `postEventFrameOverWs` synthesizes an
 * equivalent one; these tests pin that it is *equivalent* — same name, same
 * kind, same `url.full`, same status/error attributes — while still saying which
 * transport produced it.
 *
 * Unlike `events-v4-ws.test.ts`, nothing here mocks `resolveWsTransport`: the
 * spans have to come out of the real selection + transport + adapter stack, over
 * a fake socket that actually opens and replies (the harness from
 * `ws-protocol-conformance.test.ts`), or they would prove nothing about what a
 * deployment emits.
 */

import { context, trace as otelTrace, propagation } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { encode } from 'cbor-x';
import { MockAgent } from 'undici';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { withEventPostRetry } from './event-retry.js';
import {
  createWorkflowRunEventV4,
  getEventV4,
} from './events-v4.js';
import {
  type DecodedFrame,
  decodeFrames,
  encodeFrame,
  V4_FRAME_CONTENT_TYPE,
} from './frames.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockRejectedValue(new Error('no OIDC')),
}));

const { FakeWebSocket, sockets } = vi.hoisted(() => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static readonly OPEN = 1;
    readyState = 0;
    binaryType = '';
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

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
const REST_URL = `${ORIGIN}/api/v4/runs/wrun_1/events/step_completed`;
const WS_URL = `${ORIGIN.replace(/^http/, 'ws')}/api/websockets/v1/runs/wrun_1`;
const CREATED_AT = '2026-06-10T00:00:00.000Z';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider();
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  otelTrace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  context.disable();
  propagation.disable();
  otelTrace.disable();
});

beforeEach(() => {
  sockets.length = 0;
  exporter.reset();
  resetWsEventsTransportsForTest();
  process.env.WORKFLOW_EVENTS_TRANSPORT = 'ws';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.WORKFLOW_EVENTS_TRANSPORT;
  resetWsEventsTransportsForTest();
  vi.restoreAllMocks();
});

const input = {
  runId: 'wrun_1',
  eventType: 'step_completed',
  specVersion: 2,
  correlationId: 'step_1',
} as const;

/** The materialized CBOR body a `step_completed` write answers with. */
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

interface RouteResponse {
  status: number;
  body?: Uint8Array;
}

/** Answer every frame the client sends the way the v4 WS route would. */
function attachFixtureServer(
  socket: InstanceType<typeof FakeWebSocket>,
  handler: (n: number) => RouteResponse
) {
  let n = 0;
  socket.onFrame = (raw) => {
    void decodeOne(raw).then((frame) => {
      const res = handler(++n);
      socket.deliver(
        encodeFrame(
          { reqId: frame.meta.reqId, type: 'event_ack', status: res.status },
          res.body ?? new Uint8Array(0)
        )
      );
    });
  };
}

/**
 * Open the channel the way the flow route does, then let the handshake
 * complete with a fixture server attached. Returns once the socket is live, so
 * a write issued afterwards is a steady-state write rather than one that pays
 * for the handshake.
 */
async function withOpenChannel(
  handler: (n: number) => RouteResponse = () => ({
    status: 201,
    body: materializedBody(),
  })
) {
  const release = openWsChannel(input.runId, { token: 'test-token' });
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  const socket = sockets[0];
  attachFixtureServer(socket, handler);
  socket.open();
  return { socket, release };
}

const spansNamed = (name: string): ReadableSpan[] =>
  exporter.getFinishedSpans().filter((s) => s.name === name);

const writeSpan = (): ReadableSpan => {
  const spans = spansNamed('http POST');
  expect(spans).toHaveLength(1);
  return spans[0];
};

describe('per-write client span', () => {
  it('emits one `http POST` CLIENT span per event write', async () => {
    await withOpenChannel();

    await createWorkflowRunEventV4(input, { token: 'test-token' });

    const span = writeSpan();
    // SpanKind.CLIENT === 2. Asserted as the literal so a change to the kind
    // (which is what makes it render as an outgoing request) is visible here.
    expect(span.kind).toBe(2);
    expect(span.attributes['http.request.method']).toBe('POST');
    expect(span.attributes['http.response.status_code']).toBe(201);
    expect(span.attributes['error.type']).toBeUndefined();
  });

  it('reports the v4 REST endpoint as url.full, byte-identical to the HTTP path', async () => {
    await withOpenChannel();

    await createWorkflowRunEventV4(input, { token: 'test-token' });

    // Not the socket URL: the server forwards the frame into this route, and
    // naming it is what keeps a dashboard keyed on `http POST` + `url.full`
    // working across the transport flag. The HTTP-path assertion in
    // `transport parity` below pins that these two strings are the same one.
    expect(writeSpan().attributes['url.full']).toBe(REST_URL);
    expect(writeSpan().attributes['server.address']).toBe(
      new URL(ORIGIN).hostname
    );
    expect(writeSpan().attributes['peer.service']).toBe('workflow-server');
    expect(writeSpan().attributes['rpc.service']).toBe('workflow-server');
  });

  it('says plainly that it was a frame, not an HTTP request', async () => {
    await withOpenChannel();

    await createWorkflowRunEventV4(input, { token: 'test-token' });

    // A synthetic span that hid its transport would be a trap: the three
    // attributes below are what stop `url.full` from being read as "a request
    // was made to this URL".
    const span = writeSpan();
    expect(span.attributes['workflow.events.transport']).toBe('ws');
    expect(span.attributes['network.protocol.name']).toBe('websocket');
    expect(span.attributes['workflow.events.ws.url']).toBe(WS_URL);
    expect(span.attributes['workflow.event.type']).toBe('step_completed');
  });

  it('carries the reqId that joins it to the server log line for the same frame', async () => {
    await withOpenChannel((n) => ({
      status: 201,
      body: materializedBody(`evnt_${n}`),
    }));

    await createWorkflowRunEventV4(input, { token: 'test-token' });
    await createWorkflowRunEventV4(
      { ...input, correlationId: 'step_2' },
      { token: 'test-token' }
    );

    const ids = spansNamed('http POST').map(
      (s) => s.attributes['workflow.events.ws.req_id']
    );
    expect(ids).toEqual([1, 2]);
  });

  it('parents each write to the caller, not to the connection', async () => {
    await withOpenChannel();

    const tracer = otelTrace.getTracer('test');
    let invocationSpanId = '';
    await tracer.startActiveSpan('flow-invocation', async (span) => {
      invocationSpanId = span.spanContext().spanId;
      await createWorkflowRunEventV4(input, { token: 'test-token' });
      span.end();
    });

    // A write that joins an already-open socket must not be nested under the
    // handshake that happened to precede it — otherwise every write in a run
    // hangs off the first one and the trace stops showing the step it belongs
    // to.
    expect(writeSpan().parentSpanId).toBe(invocationSpanId);
  });

  it('does not synthesize a span for a write that never reached the socket', async () => {
    // No `openWsChannel`, so `resolveWsTransport` finds nothing and the write
    // falls through to HTTP, which opens its own span. Synthesizing one here
    // would double-count every write on a run whose channel failed to open.
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/step_completed',
        method: 'POST',
      })
      .reply(200, materializedBody(), {
        headers: { 'x-wf-event-id': 'evnt_1' },
      });

    await createWorkflowRunEventV4(input, {
      token: 'test-token',
      dispatcher: agent,
    });

    const spans = spansNamed('http POST');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes['workflow.events.transport']).toBe('http');
    expect(sockets).toHaveLength(0);
  });
});

describe('failure reporting', () => {
  it('records a non-2xx reply with the same error.type the fetch path uses', async () => {
    await withOpenChannel(() => ({
      status: 409,
      body: new TextEncoder().encode('{"message":"already applied"}'),
    }));

    await expect(
      createWorkflowRunEventV4(input, { token: 'test-token' })
    ).rejects.toThrow();

    const span = writeSpan();
    expect(span.attributes['http.response.status_code']).toBe(409);
    expect(span.attributes['error.type']).toBe('HTTP 409');
    // SpanStatusCode.ERROR === 2.
    expect(span.status.code).toBe(2);
    expect(span.events.map((e) => e.name)).toContain('exception');
  });

  it('records a dead socket as TRANSPORT, with no status to report', async () => {
    const { socket } = await withOpenChannel();
    // Answer nothing and drop the connection under the in-flight write.
    socket.onFrame = () => socket.close(1006);

    await expect(
      createWorkflowRunEventV4(input, { token: 'test-token' })
    ).rejects.toThrow(/transport failure/);

    const span = writeSpan();
    expect(span.attributes['error.type']).toBe('TRANSPORT');
    // Inventing a status here would make a write that was never acked
    // indistinguishable from one the server answered.
    expect(span.attributes['http.response.status_code']).toBeUndefined();
    expect(span.status.code).toBe(2);
  });

  it('emits one span per attempt, like the HTTP path does', async () => {
    // The shared retry policy (`event-retry.ts`) re-enters the adapter rather
    // than retrying inside it, so a retried write is two spans — matching
    // `instrumentedFetch`, which opens one per `fetch` call rather than one per
    // logical write. A single span spanning both attempts would hide the first
    // failure and report the retry's latency as the write's.
    await withOpenChannel((n) =>
      n === 1
        ? {
            status: 500,
            body: new TextEncoder().encode('{"message":"transient"}'),
          }
        : { status: 201, body: materializedBody() }
    );

    const result = await withEventPostRetry(
      () => createWorkflowRunEventV4(input, { token: 'test-token' }),
      'step_completed'
    );
    expect(result.event.eventId).toBe('evnt_1');

    const spans = spansNamed('http POST');
    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.attributes['http.response.status_code'])).toEqual(
      [500, 201]
    );
    expect(spans.map((s) => s.attributes['error.type'])).toEqual([
      'HTTP 500',
      undefined,
    ]);
  });
});

describe('connection span', () => {
  it('times the handshake under its own operation-named span', async () => {
    const { socket } = await withOpenChannel();
    await createWorkflowRunEventV4(input, { token: 'test-token' });
    expect(socket.readyState).toBe(1);

    // Named for the operation, not `http GET`: the upgrade is a real HTTP
    // request, but bucketing it with the event writes it enables would make
    // both unreadable.
    const connect = spansNamed('workflow.events.ws.connect');
    expect(connect).toHaveLength(1);
    expect(connect[0].kind).toBe(2);
    expect(connect[0].attributes['url.full']).toBe(WS_URL);
    expect(connect[0].attributes['workflow.events.transport']).toBe('ws');
    expect(connect[0].attributes['workflow.events.ws.reconnect_attempt']).toBe(
      0
    );
  });

  it('records a refused upgrade rather than leaving the gap unexplained', async () => {
    openWsChannel(input.runId, { token: 'test-token' });
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    sockets[0].close(1006);

    await vi.waitFor(() =>
      expect(spansNamed('workflow.events.ws.connect')).toHaveLength(1)
    );
    const connect = spansNamed('workflow.events.ws.connect')[0];
    expect(connect.attributes['error.type']).toBe('TRANSPORT');
    expect(connect.status.code).toBe(2);
  });
});

describe('transport parity', () => {
  it('does not tag an HTTP event read as an event-write transport', async () => {
    delete process.env.WORKFLOW_EVENTS_TRANSPORT;
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/evnt_1?remoteRefBehavior=resolve',
        method: 'GET',
      })
      .reply(
        200,
        encodeFrame(
          {
            eventId: 'evnt_1',
            runId: 'wrun_1',
            eventType: 'run_created',
            createdAt: CREATED_AT,
            eventData: {
              deploymentId: 'dpl_1',
              workflowName: 'workflow',
              input: null,
            },
          },
          new Uint8Array()
        ),
        { headers: { 'content-type': V4_FRAME_CONTENT_TYPE } }
      );

    await getEventV4('wrun_1', 'evnt_1', 'resolve', {
      token: 'test-token',
      dispatcher: agent,
    });

    const spans = spansNamed('http GET');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes['workflow.events.transport']).toBeUndefined();
    expect(spans[0].attributes['workflow.event.type']).toBeUndefined();
    agent.assertNoPendingInterceptors();
  });

  it('emits the same span name and url.full on HTTP as on ws', async () => {
    delete process.env.WORKFLOW_EVENTS_TRANSPORT;
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/step_completed',
        method: 'POST',
      })
      .reply(200, materializedBody(), {
        headers: { 'x-wf-event-id': 'evnt_1' },
      });

    await createWorkflowRunEventV4(input, {
      token: 'test-token',
      dispatcher: agent,
    });

    // The whole point of synthesizing the WS span: a trace taken either side of
    // the flag reads the same, so the A/B the flag exists for compares like
    // with like. Only `workflow.events.transport` separates them.
    const span = writeSpan();
    expect(span.attributes['url.full']).toBe(REST_URL);
    expect(span.attributes['http.request.method']).toBe('POST');
    expect(span.attributes['workflow.event.type']).toBe('step_completed');
    expect(span.attributes['workflow.events.transport']).toBe('http');
    expect(span.attributes['network.protocol.name']).toBeUndefined();
    agent.assertNoPendingInterceptors();
  });
});
