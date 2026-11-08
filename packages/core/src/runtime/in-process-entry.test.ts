import {
  context,
  trace as otelTrace,
  propagation,
  SpanKind,
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
 * The flow route's in-process entry (`IN_PROCESS_QUEUE_HANDLER`): the same
 * handler a World whose queue runs in the app's process delivers to without
 * HTTP. It is not a request from the network, so it is not checked as one,
 * and its span says it was in process.
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

/** A World whose queue route records each request handed to it. */
function installWorld(queueAuthMode: QueueAuthMode | undefined) {
  const routed: Request[] = [];
  const createQueueHandler = vi.fn(() => async (req: Request) => {
    routed.push(req);
    return Response.json({ ok: true });
  });
  setWorld({
    ...(queueAuthMode === undefined ? {} : { queueAuthMode }),
    specVersion: SPEC_VERSION_CURRENT,
    getDeploymentId: async () => 'dpl_test',
    createQueueHandler,
    events: { create: vi.fn(), list: vi.fn() },
    runs: { get: vi.fn() },
    queue: vi.fn(),
  } as any);
  const route = workflowEntrypoint(
    'globalThis.__private_workflows = new Map();'
  );
  const entry = route[IN_PROCESS_QUEUE_HANDLER];
  if (!entry) throw new Error('the route carries no in-process entry');
  return { routed, route, entry, createQueueHandler };
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

  it('is not checked as an HTTP request is', async () => {
    const { routed, route, entry } = installWorld('loopback');
    // Over HTTP a delivery without the key is refused...
    expect((await route(delivery())).status).toBe(401);
    expect(routed).toHaveLength(0);
    // ...and the same request through the entry reaches the handler.
    expect((await entry(delivery())).status).toBe(200);
    expect(routed).toHaveLength(1);
  });

  it('shares one handler with the route', async () => {
    const { route, entry, createQueueHandler } = installWorld('skip');
    await entry(delivery());
    await route(delivery());
    await entry(delivery());
    expect(createQueueHandler).toHaveBeenCalledTimes(1);
    expect(
      routeSpans().map((s) => s.attributes['workflow.route.handler_cached'])
    ).toEqual([false, true, true]);
    expect(
      routeSpans().map((s) => s.attributes['workflow.route.invocation_count'])
    ).toEqual([1, 2, 3]);
  });

  it('emits the route span as an internal, in-process one', async () => {
    const { route, entry } = installWorld('loopback');
    await route(delivery({ [QUEUE_AUTH_HEADER]: getQueueAuthKey() }));
    await entry(delivery());
    const [http, inProcess] = routeSpans();

    expect(http.kind).toBe(SpanKind.SERVER);
    expect(http.attributes).toMatchObject({
      'workflow.route.transport': 'http',
      'http.request.method': 'POST',
      'http.route': '/.well-known/workflow/v1/flow',
      'http.response.status_code': 200,
    });

    expect(inProcess.kind).toBe(SpanKind.INTERNAL);
    expect(inProcess.attributes).toMatchObject({
      'workflow.route.transport': 'in-process',
      'http.route': '/.well-known/workflow/v1/flow',
      'http.response.status_code': 200,
    });
    // Not a request: no method. Otherwise the same shape.
    expect(inProcess.attributes).not.toHaveProperty('http.request.method');
    const keys = (attributes: object) =>
      Object.keys(attributes)
        .filter((key) => key !== 'http.request.method')
        .sort();
    expect(keys(inProcess.attributes)).toEqual(keys(http.attributes));
  });

  it('hands every delivery to the handler, health check messages included', async () => {
    // The `?__health` probe is an HTTP affair (`withHealthCheck` on the
    // route); a queue's health check is a message, handled like any other.
    const { routed, entry } = installWorld('loopback');
    const response = await entry(
      new Request(`${FLOW_URL}?__health`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ __healthCheck: true, correlationId: 'probe' }),
      })
    );
    expect(response.status).toBe(200);
    expect(routed).toHaveLength(1);
  });
});
