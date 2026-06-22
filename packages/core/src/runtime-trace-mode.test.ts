import {
  context,
  trace as otelTrace,
  propagation,
  type Span,
  SpanKind,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
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
import { runtimeLogger } from './logger.js';
import { setWorld } from './runtime/world.js';
import { workflowEntrypoint } from './runtime.js';
import { dehydrateWorkflowArguments } from './serialization.js';
import { getNextTraceCarrier, getWorkflowTraceMode } from './telemetry.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
}));

// Run-origin trace context, as carried in queue messages. Uses a fixed,
// valid W3C traceparent so assertions are deterministic.
const ORIGIN_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const ORIGIN_SPAN_ID = 'b7ad6b7169203331';
const ORIGIN_CARRIER = {
  traceparent: `00-${ORIGIN_TRACE_ID}-${ORIGIN_SPAN_ID}-01`,
};

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

const getWorkflowTransformCode = (workflowName: string) =>
  `;globalThis.__private_workflows = new Map();
  globalThis.__private_workflows.set(${JSON.stringify(workflowName)}, ${workflowName});`;

const simpleWorkflow = `async function workflow() {
    return 'done';
  }${getWorkflowTransformCode('workflow')}`;

async function makeRunningRun(runId: string): Promise<WorkflowRun> {
  return {
    runId,
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments([], runId, undefined, []),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    deploymentId: 'test-deployment',
  };
}

/**
 * Drives the workflow queue handler once with the given trace carrier,
 * inside an active "delivery" span (simulating the span the platform/queue
 * consumer creates around the delivery request). Returns the finished
 * WORKFLOW_V2 span, the delivery span, and all queued messages.
 */
async function driveHandler(opts: {
  runId: string;
  workflowCode: string;
  traceCarrier?: Record<string, string>;
}) {
  const workflowRun = await makeRunningRun(opts.runId);
  const queuedMessages: any[] = [];

  const eventsCreate = vi.fn(async (_runId: string, data: any) => {
    if (data.eventType === 'run_started') {
      return { run: workflowRun, events: [] as Event[] };
    }
    return {
      event: {
        eventId: `event-${Math.random()}`,
        runId: workflowRun.runId,
        createdAt: new Date(),
        ...data,
      },
    };
  });

  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    createQueueHandler: vi.fn(
      (
        _prefix: string,
        handler: (message: unknown, metadata: unknown) => Promise<unknown>
      ) => {
        return async () => {
          await handler(
            {
              runId: workflowRun.runId,
              requestedAt: new Date('2024-01-01T00:00:00.000Z'),
              traceCarrier: opts.traceCarrier,
            },
            {
              requestId: 'req_test',
              attempt: 1,
              queueName: '__wkf_workflow_workflow',
              messageId: 'msg_test',
            }
          );
          return new Response(null, { status: 204 });
        };
      }
    ),
    events: {
      create: eventsCreate,
      list: vi.fn(async () => ({
        data: [] as Event[],
        hasMore: false,
        cursor: 'cursor_test',
      })),
    },
    runs: {
      get: vi.fn(async () => workflowRun),
    },
    queue: vi.fn(async (_queueName: string, message: unknown) => {
      queuedMessages.push(message);
      return { messageId: null };
    }),
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  const handler = workflowEntrypoint(opts.workflowCode);

  // Invoke inside an active "delivery" span so linkToCurrentContext()
  // observes a live delivery context, as it would in production.
  const tracer = otelTrace.getTracer('test');
  let deliverySpan!: Span;
  await tracer.startActiveSpan('queue delivery', async (span) => {
    deliverySpan = span;
    try {
      await handler(new Request('https://example.test'));
    } finally {
      span.end();
    }
  });

  const workflowSpan = exporter
    .getFinishedSpans()
    .find((s) => s.name === 'workflow.execute workflow');

  return { workflowSpan, deliverySpan, queuedMessages };
}

function linkTraceIds(span: ReadableSpan | undefined): string[] {
  return (span?.links ?? []).map((l) => l.context.traceId);
}

describe('getWorkflowTraceMode', () => {
  it('defaults to linked when WORKFLOW_TRACE_MODE is unset', () => {
    vi.stubEnv('WORKFLOW_TRACE_MODE', '');
    expect(getWorkflowTraceMode()).toBe('linked');
  });

  it('returns continuous when WORKFLOW_TRACE_MODE=continuous', () => {
    vi.stubEnv('WORKFLOW_TRACE_MODE', 'continuous');
    expect(getWorkflowTraceMode()).toBe('continuous');
  });

  it('warns once for unrecognized values and falls back to linked', () => {
    const warnSpy = vi
      .spyOn(runtimeLogger, 'warn')
      .mockImplementation(() => {});
    vi.stubEnv('WORKFLOW_TRACE_MODE', 'continous');

    expect(getWorkflowTraceMode()).toBe('linked');
    expect(getWorkflowTraceMode()).toBe('linked');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('"continous"');
    expect(message).toContain('"linked"');
    expect(message).toContain('"continuous"');
    warnSpy.mockRestore();
  });
});

describe('workflowEntrypoint trace modes', () => {
  it('linked (default): nests under the delivery context with a link to the run-origin context', async () => {
    const { workflowSpan, deliverySpan } = await driveHandler({
      runId: 'wrun_trace_linked',
      workflowCode: simpleWorkflow,
      traceCarrier: ORIGIN_CARRIER,
    });

    expect(workflowSpan).toBeDefined();
    // Child of the local delivery (flow-route) span — same trace, so one
    // invocation is a single bounded trace rather than a new root.
    expect(workflowSpan?.parentSpanId).toBe(deliverySpan.spanContext().spanId);
    expect(workflowSpan?.spanContext().traceId).toBe(
      deliverySpan.spanContext().traceId
    );

    // Single link to the run-origin context (NOT a parent) — connecting this
    // bounded invocation trace back to where the run was started.
    expect(workflowSpan?.links).toHaveLength(1);
    expect(linkTraceIds(workflowSpan)).toContain(ORIGIN_TRACE_ID);
    // The delivery context is the parent now, so it is not also a link.
    expect(linkTraceIds(workflowSpan)).not.toContain(
      deliverySpan.spanContext().traceId
    );

    expect(workflowSpan?.attributes['workflow.trace.mode']).toBe('linked');
    expect(workflowSpan?.attributes['workflow.trace.propagated']).toBe(true);

    // Queue-delivered invocation spans use the CONSUMER kind, matching
    // queue-delivered step.execute spans.
    expect(workflowSpan?.kind).toBe(SpanKind.CONSUMER);
  });

  it('linked: treats an empty trace carrier ({}) like an absent one', async () => {
    const { workflowSpan, deliverySpan } = await driveHandler({
      runId: 'wrun_trace_linked_empty_carrier',
      workflowCode: simpleWorkflow,
      traceCarrier: {},
    });

    expect(workflowSpan).toBeDefined();
    // Still nested under the delivery context...
    expect(workflowSpan?.parentSpanId).toBe(deliverySpan.spanContext().spanId);
    // ...but no run-origin link is derived from `{}`.
    expect(workflowSpan?.links ?? []).toHaveLength(0);
    // An empty carrier does not count as propagated trace context.
    expect(workflowSpan?.attributes['workflow.trace.propagated']).toBe(false);
  });

  it('linked: without an incoming carrier, nests under the delivery context with no links', async () => {
    const { workflowSpan, deliverySpan } = await driveHandler({
      runId: 'wrun_trace_linked_no_carrier',
      workflowCode: simpleWorkflow,
      traceCarrier: undefined,
    });

    expect(workflowSpan).toBeDefined();
    expect(workflowSpan?.parentSpanId).toBe(deliverySpan.spanContext().spanId);
    expect(workflowSpan?.links ?? []).toHaveLength(0);
    expect(workflowSpan?.attributes['workflow.trace.propagated']).toBe(false);
  });

  it('continuous: preserves the legacy shape — parented to the run-origin context with a delivery link', async () => {
    vi.stubEnv('WORKFLOW_TRACE_MODE', 'continuous');

    const { workflowSpan, deliverySpan } = await driveHandler({
      runId: 'wrun_trace_continuous',
      workflowCode: simpleWorkflow,
      traceCarrier: ORIGIN_CARRIER,
    });

    expect(workflowSpan).toBeDefined();
    // Same trace as the run origin, parented to the carrier's span.
    expect(workflowSpan?.spanContext().traceId).toBe(ORIGIN_TRACE_ID);
    expect(workflowSpan?.parentSpanId).toBe(ORIGIN_SPAN_ID);

    // Only the delivery link (no self-link to the origin).
    expect(workflowSpan?.links).toHaveLength(1);
    expect(linkTraceIds(workflowSpan)).toContain(
      deliverySpan.spanContext().traceId
    );

    expect(workflowSpan?.attributes['workflow.trace.mode']).toBe('continuous');
  });
});

// The carrier put on re-enqueued messages is produced by getNextTraceCarrier.
// (The combined V2 handler now executes a single owned step inline rather
// than queueing it, so this invariant is exercised directly on the helper
// instead of by inspecting a queued step message.)
describe('getNextTraceCarrier (re-enqueue carrier semantics)', () => {
  it('linked: forwards a usable run-origin carrier unchanged', async () => {
    // The original carrier flows forward unchanged so the run-origin
    // identity is preserved for future links.
    const next = await getNextTraceCarrier('linked', ORIGIN_CARRIER);
    expect(next).toEqual(ORIGIN_CARRIER);
  });

  it('linked: replaces an empty carrier with the current invocation context', async () => {
    const tracer = otelTrace.getTracer('test');
    let activeTraceId = '';
    const next = await tracer.startActiveSpan('inv', async (span) => {
      activeTraceId = span.spanContext().traceId;
      try {
        return await getNextTraceCarrier('linked', {});
      } finally {
        span.end();
      }
    });
    // The useless `{}` is not forwarded — this invocation serializes its
    // own context, becoming the de-facto run origin for future links.
    expect(next.traceparent).toContain(activeTraceId);
    expect(next.traceparent).not.toBe(ORIGIN_CARRIER.traceparent);
  });

  it('continuous: serializes the current invocation context, not the origin carrier', async () => {
    const tracer = otelTrace.getTracer('test');
    let activeTraceId = '';
    const next = await tracer.startActiveSpan('inv', async (span) => {
      activeTraceId = span.spanContext().traceId;
      try {
        return await getNextTraceCarrier('continuous', ORIGIN_CARRIER);
      } finally {
        span.end();
      }
    });
    // Continuous mode always serializes the current context rather than
    // forwarding the incoming carrier.
    expect(next.traceparent).toContain(activeTraceId);
    expect(next.traceparent).not.toBe(ORIGIN_CARRIER.traceparent);
    expect(activeTraceId).not.toBe(ORIGIN_TRACE_ID);
  });
});
