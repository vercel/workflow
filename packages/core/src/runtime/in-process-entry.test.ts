import {
  context,
  trace as otelTrace,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { getQueueAuthKey, QUEUE_AUTH_HEADER } from '@workflow/utils';
import {
  IN_PROCESS_QUEUE_HANDLER,
  type InProcessDelivery,
  MessageId,
  type QueueAuthMode,
  SPEC_VERSION_CURRENT,
} from '@workflow/world';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { workflowEntrypoint } from '../runtime.js';
import { setWorld } from './world.js';

/**
 * The flow route's in-process entry (`IN_PROCESS_QUEUE_HANDLER`): the
 * runtime's handler, which a World whose queue runs in the app's process
 * calls with the message and its metadata, without HTTP. It is not a
 * request from the network, so it is not checked as one, and its span says
 * it was in process.
 */

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
  setWorld(undefined);
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const FLOW_URL = 'http://localhost:3000/.well-known/workflow/v1/flow';

function delivery(headers: Record<string, string> = {}): Request {
  return new Request(FLOW_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ runId: 'wrun_in_process' }),
  });
}

/** The same delivery, as a World hands it to the in-process entry. */
function inProcess(): InProcessDelivery {
  return {
    message: { __healthCheck: true, correlationId: 'probe' },
    meta: {
      queueName: '__wkf_workflow_probe',
      messageId: MessageId.parse('msg_in_process'),
      attempt: 2,
      deliveryCount: 3,
    },
  };
}

/**
 * A World whose queue route records each request handed to it. Its route
 * handler hands the runtime's handler a health check, so the runtime's
 * handler is reached either way without a run.
 */
function installWorld(queueAuthMode: QueueAuthMode | undefined) {
  const routed: Request[] = [];
  const handled: unknown[] = [];
  const createQueueHandler = vi.fn(
    (_prefix: string, handler: (message: unknown, meta: unknown) => unknown) =>
      async (req: Request) => {
        routed.push(req);
        await handler(inProcess().message, inProcess().meta);
        return Response.json({ ok: true });
      }
  );
  setWorld({
    ...(queueAuthMode === undefined ? {} : { queueAuthMode }),
    specVersion: SPEC_VERSION_CURRENT,
    getDeploymentId: async () => 'dpl_test',
    createQueueHandler,
    events: { create: vi.fn(), list: vi.fn() },
    runs: { get: vi.fn() },
    queue: vi.fn(),
    // A health check message answers on a stream.
    streams: { write: vi.fn(async () => {}), close: vi.fn(async () => {}) },
  } as any);
  const route = workflowEntrypoint(
    'globalThis.__private_workflows = new Map();'
  );
  const entry = route[IN_PROCESS_QUEUE_HANDLER];
  if (!entry) throw new Error('the route carries no in-process entry');
  return { routed, handled, route, entry, createQueueHandler };
}

const routeSpans = () =>
  exporter.getFinishedSpans().filter((s) => s.name === 'workflow.route.flow');

describe('the flow route in-process entry', () => {
  it('is on the route, and not enumerable', () => {
    const { route, entry } = installWorld('loopback');
    expect(typeof entry).toBe('function');
    expect(Object.keys(route)).toEqual([]);
    expect(Object.getOwnPropertySymbols({ ...route })).toEqual([]);
    expect(
      Object.getOwnPropertyDescriptor(route, IN_PROCESS_QUEUE_HANDLER)
        ?.enumerable
    ).toBe(false);
  });

  it('is not checked as an HTTP request is, and takes the message and its metadata directly', async () => {
    const { routed, route, entry } = installWorld('loopback');
    // Over HTTP a delivery without the key is refused...
    expect((await route(delivery())).status).toBe(401);
    expect(routed).toHaveLength(0);
    // ...and a delivery through the entry reaches the runtime's handler,
    // without a request: the World's route handler is not involved.
    await expect(entry(inProcess())).resolves.toBeUndefined();
    expect(routed).toHaveLength(0);
  });

  it('shares one runtime handler with the route', async () => {
    const { route, entry, createQueueHandler } = installWorld('allow');
    await entry(inProcess());
    await route(delivery());
    await entry(inProcess());
    expect(createQueueHandler).toHaveBeenCalledTimes(1);
    expect(
      routeSpans().map((s) => s.attributes['workflow.route.handler_cached'])
    ).toEqual([false, true, true]);
    expect(
      routeSpans().map((s) => s.attributes['workflow.route.invocation_count'])
    ).toEqual([1, 2, 3]);
  });

  it('emits the route span as an internal, in-process one with the delivery identity', async () => {
    const { route, entry } = installWorld('loopback');
    await route(delivery({ [QUEUE_AUTH_HEADER]: getQueueAuthKey() }));
    await entry(inProcess());
    const [http, direct] = routeSpans();

    expect(http.name).toBe('workflow.route.flow');
    expect(http.kind).toBe(SpanKind.SERVER);
    expect(http.attributes).toMatchObject({
      'workflow.route.transport': 'http',
      'http.request.method': 'POST',
      'http.route': '/.well-known/workflow/v1/flow',
      'http.response.status_code': 200,
    });

    expect(direct.name).toBe('workflow.route.flow');
    expect(direct.kind).toBe(SpanKind.INTERNAL);
    expect(direct.attributes).toMatchObject({
      'workflow.route.transport': 'in-process',
      'http.route': '/.well-known/workflow/v1/flow',
      // What a request's method and status were for the HTTP span, the
      // delivery's identity is for this one.
      'messaging.destination.name': '__wkf_workflow_probe',
      'messaging.message.id': 'msg_in_process',
      'workflow.delivery.attempt': 2,
      'workflow.delivery.count': 3,
    });
    // Not a request: no method, no status.
    expect(direct.attributes).not.toHaveProperty('http.request.method');
    expect(direct.attributes).not.toHaveProperty('http.response.status_code');
    // The route's own attributes are the same set on both.
    const routeKeys = (attributes: object) =>
      Object.keys(attributes)
        .filter(
          (key) => key.startsWith('workflow.route.') || key === 'faas.instance'
        )
        .sort();
    expect(routeKeys(direct.attributes)).toEqual(routeKeys(http.attributes));
    expect(routeKeys(direct.attributes)).toEqual([
      'faas.instance',
      'workflow.route.entrypoint_age_ms',
      'workflow.route.handler_cached',
      'workflow.route.invocation_count',
      'workflow.route.transport',
      'workflow.route.type',
    ]);
  });

  it('starts a new trace for each delivery, whatever span is active in the process', async () => {
    const { entry } = installWorld('deny');
    // The runner may have been started from inside a user request; its
    // deliveries must not become children of that request's trace.
    const tracer = otelTrace.getTracer('test');
    let outer!: Span;
    await tracer.startActiveSpan('user request', async (span) => {
      outer = span;
      try {
        await entry(inProcess());
      } finally {
        span.end();
      }
    });
    const [route] = routeSpans();
    expect(route.parentSpanId).toBeUndefined();
    expect(route.spanContext().traceId).not.toBe(outer.spanContext().traceId);
  });

  it('marks the span as failed when the handler rejects', async () => {
    const { entry } = installWorld('deny');
    await expect(
      entry({ message: { not: 'a message' }, meta: inProcess().meta })
    ).rejects.toThrow();
    const [route] = routeSpans();
    expect(route.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('delivers regardless of an aborted signal, as the HTTP route does for an aborted request', async () => {
    // The runtime does not act on a delivery's signal on either transport:
    // the message is run to completion once accepted. A World's own handler
    // for a consumer prefix may watch it.
    const { entry, routed } = installWorld('deny');
    const controller = new AbortController();
    controller.abort();
    await expect(
      entry({ ...inProcess(), signal: controller.signal })
    ).resolves.toBeUndefined();
    expect(routed).toHaveLength(0);
  });

  it("returns what the runtime's handler returned, and rejects with what it threw", async () => {
    const { entry } = installWorld('deny');
    // A health check message: handled, nothing to return.
    await expect(entry(inProcess())).resolves.toBeUndefined();
    // A message the runtime cannot parse: the handler's error, not a 500.
    await expect(
      entry({ message: { not: 'a message' }, meta: inProcess().meta })
    ).rejects.toThrow();
  });
});
