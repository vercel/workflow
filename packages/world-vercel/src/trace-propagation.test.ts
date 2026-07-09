import { context, trace as otelTrace, propagation } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { encode } from 'cbor-x';
import { MockAgent } from 'undici';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import { getWorkflowRunEventsV4 } from './events-v4.js';
import { encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';
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

afterEach(() => {
  exporter.reset();
  vi.unstubAllGlobals();
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
