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
import { getWorkflowRunEventsV4 } from './events-v4.js';
import { encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';
import { createStreamer } from './streamer.js';
import { injectTraceContextIntoHeaders } from './telemetry.js';
import { makeRequest } from './utils.js';

vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockRejectedValue(new Error('no OIDC')),
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
    const origin = 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get(origin)
      .intercept({ path: '/api/v4/runs/wrun_1/events', method: 'GET' })
      .reply(200, encodeFrame({ _end: 1 }, new Uint8Array(0)), {
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
    const traceparent = sent.get('traceparent');
    // The v4 path issues its request through the shared instrumented envelope,
    // so it opens its own `http GET` CLIENT span (a child of the
    // flow-invocation span) and injects from inside it — matching the v3
    // makeRequest path. Without that injection the header is absent and the
    // backend cannot parent its spans to the flow-route invocation.
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

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
});

describe('streamer write trace propagation', () => {
  it('injects traceparent on the outgoing stream write, parented to the client span', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const streamer = createStreamer({ token: 'test-token' });

    const tracer = otelTrace.getTracer('test');
    let traceId = '';
    let spanId = '';
    await tracer.startActiveSpan('flow-invocation', async (span) => {
      traceId = span.spanContext().traceId;
      spanId = span.spanContext().spanId;
      await streamer.writeToStream('user', 'wrun_1', 'chunk');
      span.end();
    });

    const calledInit = fetchMock.mock.calls[0][1];
    const sent = new Headers(calledInit?.headers as HeadersInit);
    const traceparent = sent.get('traceparent');
    // Stream writes ride the same instrumented envelope as the event paths, so
    // the backend can correlate a write with the run that issued it.
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    const clientSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'http PUT');
    expect(clientSpan).toBeDefined();
    expect(clientSpan?.spanContext().traceId).toBe(traceId);
    expect(clientSpan?.parentSpanId).toBe(spanId);
    expect(traceparent).toBe(
      `00-${traceId}-${clientSpan?.spanContext().spanId}-01`
    );
  });
});

// Every suite above reads the outgoing headers off a `fetch` stub or an undici
// MockAgent, so none of them would notice if the node:http client dropped the
// injection. This one puts a real origin on loopback and reads the header off
// the wire.
describe('node:http mode trace propagation', () => {
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
    expect(clientSpan?.attributes['workflow.http.transport']).toBe('node-http');
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
});
