import { context, trace as otelTrace, propagation } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { encode } from 'cbor-x';
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
