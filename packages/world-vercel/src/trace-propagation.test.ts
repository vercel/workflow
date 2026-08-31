import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, trace as otelTrace, propagation } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NODE_HTTP_ENV_VAR } from '@workflow/world';
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
import { z } from 'zod';
import {
  createHookReceivedPreloadEventV4,
  getWorkflowRunEventsV4,
} from './events-v4.js';
import { encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';
import { injectTraceContextIntoHeaders } from './telemetry.js';
import { makeRequest, WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockRejectedValue(new Error('no OIDC')),
}));

/**
 * The WS transport can only carry trace context on the upgrade — frames have no
 * headers — so the assertion is on what reaches the `ws` constructor. This fake
 * records that and stays in CONNECTING; no test here needs a handshake.
 */
const { wsUpgrades } = vi.hoisted(() => ({
  wsUpgrades: [] as { url: string; headers: Record<string, string> }[],
}));

vi.mock('ws', () => ({
  WebSocket: class {
    static OPEN = 1;
    readyState = 0;
    constructor(url: string, options?: { headers?: Record<string, string> }) {
      wsUpgrades.push({ url, headers: options?.headers ?? {} });
    }
    on() {
      return this;
    }
    send() {}
    close() {}
    terminate() {}
  },
}));

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

// The HTTP suites below read the outgoing headers off a stubbed `fetch` or an
// undici MockAgent, neither of which the node:http path goes through. It gets
// its own suite at the bottom of this file, against a loopback origin.
beforeEach(() => {
  vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
});

afterEach(() => {
  exporter.reset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Minimal 2xx CBOR response, mirroring utils.test.ts. */
function cborResponse(data: unknown) {
  const bytes = encode(data);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (k: string) =>
        k.toLowerCase() === 'content-type' ? 'application/cbor' : null,
    },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

describe('injectTraceContextIntoHeaders', () => {
  it('injects traceparent for the active span', async () => {
    const tracer = otelTrace.getTracer('test');
    await tracer.startActiveSpan('client', async (span) => {
      const headers = new Headers();
      await injectTraceContextIntoHeaders(headers);
      expect(headers.get('traceparent')).toBe(
        `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`
      );
      span.end();
    });
  });

  it('is a no-op when there is no active span context', async () => {
    const headers = new Headers();
    await injectTraceContextIntoHeaders(headers);
    expect(headers.get('traceparent')).toBeNull();
  });
});

describe('makeRequest trace propagation', () => {
  const schema = z.object({ value: z.string() });

  it('sends traceparent on the outgoing workflow-server request, parented to the client span', async () => {
    const fetchMock = vi.fn().mockResolvedValue(cborResponse({ value: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeRequest({
      endpoint: '/v3/runs/wrun_test/events',
      options: { method: 'GET' },
      schema,
    });
    expect(result).toEqual({ value: 'ok' });

    const request = fetchMock.mock.calls[0][0] as Request;
    const traceparent = request.headers.get('traceparent');
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    // The injected context must be the `http GET` CLIENT span created by
    // makeRequest, so the server's spans become its children.
    const clientSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'http GET');
    expect(clientSpan).toBeDefined();
    expect(traceparent).toBe(
      `00-${clientSpan?.spanContext().traceId}-${clientSpan?.spanContext().spanId}-01`
    );
  });
});

describe('v4 event requests (fetchV4) trace propagation', () => {
  it('sends traceparent on the outgoing v4 request, propagating the active context to workflow-server', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events?returnAll=true',
        method: 'GET',
      })
      .reply(200, encodeFrame({ _end: 1, hasMore: false }, new Uint8Array(0)), {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    // Spy passes through to the real fetch (MockAgent intercepts at the
    // dispatcher layer) so we can read the headers fetchV4 actually sent.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const tracer = otelTrace.getTracer('test');
    let traceId = '';
    let spanId = '';
    await tracer.startActiveSpan('flow-invocation', async (span) => {
      traceId = span.spanContext().traceId;
      spanId = span.spanContext().spanId;
      await getWorkflowRunEventsV4(
        'wrun_1',
        {},
        { token: 'test-token', dispatcher: agent }
      );
      span.end();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledInit = fetchSpy.mock.calls[0][1];
    const sent = new Headers(calledInit?.headers as HeadersInit);
    // Without the fetchV4 injection this header is absent and workflow-server
    // cannot parent its spans to the flow-route invocation.
    const traceparent = sent.get('traceparent');
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    // The v4 path now opens its own `http GET` CLIENT span (a child of the
    // flow-invocation span) and injects from inside it — matching the v3
    // makeRequest path — so the server parents to the client span and the whole
    // chain stays on one trace.
    const clientSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'http GET');
    expect(clientSpan).toBeDefined();
    expect(clientSpan?.spanContext().traceId).toBe(traceId);
    expect(clientSpan?.parentSpanId).toBe(spanId);
    expect(traceparent).toBe(
      `00-${traceId}-${clientSpan?.spanContext().spanId}-01`
    );
    agent.assertNoPendingInterceptors();
    fetchSpy.mockRestore();
  });

  it('sends traceparent and the frame Accept on the hook_received preload POST', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/hook_received',
        method: 'POST',
      })
      .reply(200, encodeFrame({ _end: 1, hasMore: false }, new Uint8Array(0)), {
        headers: {
          'content-type': V4_FRAME_CONTENT_TYPE,
          'x-wf-event-id': 'evnt_1',
          'x-wf-run-id': 'wrun_1',
          'x-wf-created-at': '2026-06-10T00:00:00.000Z',
          'x-wf-max-events': '10000',
        },
      });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const tracer = otelTrace.getTracer('test');
    let traceId = '';
    await tracer.startActiveSpan('flow-invocation', async (span) => {
      traceId = span.spanContext().traceId;
      await createHookReceivedPreloadEventV4(
        {
          runId: 'wrun_1',
          eventType: 'hook_received',
          specVersion: 2,
          correlationId: 'hook_1',
          resumeId: 'resume-trace-1',
          resumePayloadDigest: 'e'.repeat(64),
          hookToken: 'tok-trace',
        },
        { token: 'test-token', dispatcher: agent }
      );
      span.end();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledInit = fetchSpy.mock.calls[0][1];
    const sent = new Headers(calledInit?.headers as HeadersInit);
    // The preload POST rides the same fetchV4 envelope as every other v4
    // event request: trace context injected inside the client span...
    const traceparent = sent.get('traceparent');
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    const clientSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'http POST');
    expect(clientSpan).toBeDefined();
    expect(clientSpan?.spanContext().traceId).toBe(traceId);
    expect(traceparent).toBe(
      `00-${traceId}-${clientSpan?.spanContext().spanId}-01`
    );
    // ...while still negotiating the streamed replay-log response.
    expect(sent.get('accept')).toBe(V4_FRAME_CONTENT_TYPE);
    agent.assertNoPendingInterceptors();
    fetchSpy.mockRestore();
  });
});

describe('streamer write trace propagation', () => {
  it('injects traceparent on the outgoing stream write, parented to the client span', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { createStreamer } = await import('./streamer.js');
    const streamer = createStreamer({ token: 'test-token' });

    const tracer = otelTrace.getTracer('test');
    let traceId = '';
    let spanId = '';
    await tracer.startActiveSpan('flow-invocation', async (span) => {
      traceId = span.spanContext().traceId;
      spanId = span.spanContext().spanId;
      await streamer.streams.write('wrun_1', 'user', 'chunk');
      span.end();
    });

    const calledInit = fetchMock.mock.calls[0][1];
    const sent = new Headers(calledInit?.headers as HeadersInit);
    const traceparent = sent.get('traceparent');
    // Stream writes previously skipped trace-context injection; they now share
    // the instrumented envelope, so workflow-server can correlate the write.
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    // The stream write shares the instrumented envelope but is named for the
    // stream operation (not the bare `http PUT` verb) and carries stream
    // attributes so write latency is sliceable by run/stream.
    const clientSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'workflow.stream.write');
    expect(clientSpan).toBeDefined();
    expect(clientSpan?.attributes['workflow.stream.operation']).toBe('write');
    expect(clientSpan?.attributes['workflow.stream.name']).toBe('user');
    expect(clientSpan?.attributes['workflow.run.id']).toBe('wrun_1');
    expect(clientSpan?.spanContext().traceId).toBe(traceId);
    expect(clientSpan?.parentSpanId).toBe(spanId);
    expect(traceparent).toBe(
      `00-${traceId}-${clientSpan?.spanContext().spanId}-01`
    );
  });
});

describe('ws events transport upgrade trace propagation', () => {
  // `openWsChannel` is gated, unlike the `resolveWsTransport` lookup it
  // replaced: nothing opens a channel on the HTTP default.
  beforeEach(() => {
    vi.stubEnv('WORKFLOW_EVENTS_TRANSPORT', 'ws');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    wsUpgrades.length = 0;
    const { resetWsEventsTransportsForTest } = await import(
      './ws-transport.js'
    );
    resetWsEventsTransportsForTest();
  });

  it('injects traceparent on the upgrade, from its own connect span under the invocation', async () => {
    const { openWsChannel } = await import('./ws-transport.js');

    const tracer = otelTrace.getTracer('test');
    let traceId = '';
    let spanId = '';
    await tracer.startActiveSpan('flow-invocation', async (span) => {
      traceId = span.spanContext().traceId;
      spanId = span.spanContext().spanId;
      openWsChannel('wrun_1', { token: 'test-token' });
      await vi.waitFor(() => expect(wsUpgrades).toHaveLength(1));
      span.end();
    });

    // Every event written over this socket is parented to whoever opened it —
    // there is no per-frame traceparent to fall back on, so an uninjected
    // upgrade orphans the server's spans for the whole run.
    const traceparent = wsUpgrades[0]?.headers.traceparent;
    expect(traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));

    // The handshake carries a client span of its own, so what the server
    // parents to is that span rather than the invocation directly — the same
    // relationship `makeRequest` establishes, and what makes a write that waits
    // on a handshake show the wait as a span instead of unattributed time. The
    // fake socket never opens, so that span is still recording and hasn't been
    // exported; the injected context is the only view of it here, and it must
    // not be the invocation's own. `ws-transport-spans.test.ts` asserts the
    // finished span against a socket that does open.
    expect(traceparent).not.toBe(`00-${traceId}-${spanId}-01`);
  });

  it('injects traceparent on the upgrade even when no span is active', async () => {
    const { openWsChannel } = await import('./ws-transport.js');
    openWsChannel('wrun_2', { token: 'test-token' });
    await vi.waitFor(() => expect(wsUpgrades).toHaveLength(1));

    // Parity with every HTTP path: `instrumentedFetch` opens a client span
    // whether or not one is already active, so the request is always
    // correlatable. Before the connect span existed this upgrade went out
    // uninjected and the server's spans for the whole run were orphaned.
    expect(wsUpgrades[0]?.headers.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/
    );
    // The rest of the upgrade must survive an absent propagator unchanged.
    expect(wsUpgrades[0]?.headers.authorization).toBe('Bearer test-token');
  });
});

// Every suite above reads the outgoing headers off a `fetch` stub or an undici
// MockAgent, so none of them would notice if the node:http client dropped the
// injection. This one puts a real origin on loopback and reads the header off
// the wire.
// These run against a loopback origin, which they select through
// `VERCEL_WORKFLOW_SERVER_URL`. The inline `WORKFLOW_SERVER_URL_OVERRIDE`
// constant WINS over that env var by design, so while a branch-testing
// override is pinned there is no way for these to reach their own server and
// every request leaves the machine. Skipped in that case rather than left to
// fail confusingly; they run again the moment the override goes back to ''.
describe.skipIf(WORKFLOW_SERVER_URL_OVERRIDE !== '')(
  'node:http mode trace propagation',
  () => {
    let server: Server | undefined;

    beforeEach(() => {
      vi.stubEnv(NODE_HTTP_ENV_VAR, '1');
    });

    afterEach(async () => {
      const toClose = server;
      server = undefined;
      if (toClose) {
        toClose.closeAllConnections();
        await new Promise((resolve) => toClose.close(resolve));
      }
    });

    it('sends traceparent on a request that never touches undici, parented to the client span', async () => {
      const schema = z.object({ value: z.string() });
      let sentTraceparent: string | undefined;

      server = createServer((request, response) => {
        sentTraceparent = request.headers.traceparent as string | undefined;
        request.resume();
        response.setHeader('content-type', 'application/cbor');
        response.end(encode({ value: 'ok' }));
      });
      await new Promise<void>((resolve) =>
        server?.listen(0, '127.0.0.1', resolve)
      );
      const { port } = server.address() as AddressInfo;
      vi.stubEnv('VERCEL_WORKFLOW_SERVER_URL', `http://127.0.0.1:${port}`);

      const tracer = otelTrace.getTracer('test');
      let traceId = '';
      let spanId = '';
      await tracer.startActiveSpan('flow-invocation', async (span) => {
        traceId = span.spanContext().traceId;
        spanId = span.spanContext().spanId;
        const result = await makeRequest({
          endpoint: '/v3/runs/wrun_test/events',
          options: { method: 'GET' },
          schema,
        });
        expect(result).toEqual({ value: 'ok' });
        span.end();
      });

      expect(sentTraceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
      const clientSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name === 'http GET');
      expect(clientSpan?.spanContext().traceId).toBe(traceId);
      expect(clientSpan?.parentSpanId).toBe(spanId);
      expect(sentTraceparent).toBe(
        `00-${traceId}-${clientSpan?.spanContext().spanId}-01`
      );
      // Both transports emit `http GET` against the same `url.full`, so this
      // attribute is the only thing in a trace that names which one ran.
      expect(clientSpan?.attributes['workflow.http.transport']).toBe(
        'node-http'
      );
    });

    it('marks the undici path with the same attribute', async () => {
      vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
      const schema = z.object({ value: z.string() });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => cborResponse({ value: 'ok' }))
      );

      await makeRequest({
        endpoint: '/v3/runs/wrun_test/events',
        options: { method: 'GET' },
        schema,
      });

      const clientSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name === 'http GET');
      expect(clientSpan?.attributes['workflow.http.transport']).toBe('undici');
    });
  }
);
