import {
  context,
  trace as otelTrace,
  propagation,
  type Span,
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
import { setWorld } from './runtime/world.js';
import { workflowEntrypoint } from './runtime.js';
import { dehydrateWorkflowArguments } from './serialization.js';
import { getWorkflowTraceMode } from './telemetry.js';

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

// A workflow that suspends on a step AND a sleep: the pending wait makes the
// V2 handler queue the step (with a traceCarrier) instead of executing it
// inline, exercising the re-enqueue trace-carrier path.
const stepWithSleepWorkflow = `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    const [a] = await Promise.all([add(1, 2), sleep('1h')]);
    return a;
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
});

describe('workflowEntrypoint trace modes', () => {
  it('linked (default): creates the WORKFLOW_V2 span as a new root with links to delivery and run-origin contexts', async () => {
    const { workflowSpan, deliverySpan } = await driveHandler({
      runId: 'wrun_trace_linked',
      workflowCode: simpleWorkflow,
      traceCarrier: ORIGIN_CARRIER,
    });

    expect(workflowSpan).toBeDefined();
    // New root: no parent, and a fresh trace distinct from both the
    // delivery trace and the run-origin trace.
    expect(workflowSpan?.parentSpanId).toBeUndefined();
    expect(workflowSpan?.spanContext().traceId).not.toBe(ORIGIN_TRACE_ID);
    expect(workflowSpan?.spanContext().traceId).not.toBe(
      deliverySpan.spanContext().traceId
    );

    // Links to BOTH the delivery context and the run-origin context.
    expect(workflowSpan?.links).toHaveLength(2);
    expect(linkTraceIds(workflowSpan)).toContain(
      deliverySpan.spanContext().traceId
    );
    expect(linkTraceIds(workflowSpan)).toContain(ORIGIN_TRACE_ID);

    expect(workflowSpan?.attributes['workflow.trace.mode']).toBe('linked');
    expect(workflowSpan?.attributes['workflow.trace.propagated']).toBe(true);
  });

  it('linked: without an incoming carrier, still creates a root span with only the delivery link', async () => {
    const { workflowSpan, deliverySpan } = await driveHandler({
      runId: 'wrun_trace_linked_no_carrier',
      workflowCode: simpleWorkflow,
      traceCarrier: undefined,
    });

    expect(workflowSpan).toBeDefined();
    expect(workflowSpan?.parentSpanId).toBeUndefined();
    expect(workflowSpan?.links).toHaveLength(1);
    expect(linkTraceIds(workflowSpan)).toContain(
      deliverySpan.spanContext().traceId
    );
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

  it('linked: forwards the ORIGINAL run-origin trace carrier unchanged on re-enqueues', async () => {
    const { workflowSpan, queuedMessages } = await driveHandler({
      runId: 'wrun_trace_linked_reenqueue',
      workflowCode: stepWithSleepWorkflow,
      traceCarrier: ORIGIN_CARRIER,
    });

    const stepDispatch = queuedMessages.find((m) => m && 'stepId' in m);
    expect(stepDispatch).toBeDefined();
    // The original carrier flows forward unchanged — the run-origin
    // identity is preserved for future links...
    expect(stepDispatch.traceCarrier).toEqual(ORIGIN_CARRIER);
    // ...and is NOT replaced with the current invocation's context.
    expect(stepDispatch.traceCarrier.traceparent).not.toContain(
      workflowSpan?.spanContext().traceId
    );
  });

  it('continuous: serializes the current invocation context on re-enqueues', async () => {
    vi.stubEnv('WORKFLOW_TRACE_MODE', 'continuous');

    const { queuedMessages } = await driveHandler({
      runId: 'wrun_trace_continuous_reenqueue',
      workflowCode: stepWithSleepWorkflow,
      traceCarrier: ORIGIN_CARRIER,
    });

    const stepDispatch = queuedMessages.find((m) => m && 'stepId' in m);
    expect(stepDispatch).toBeDefined();
    // Continuous mode chains the trace: the queued carrier stays in the
    // run-origin trace but points at the current invocation's span, not
    // the original origin span.
    expect(stepDispatch.traceCarrier.traceparent).toContain(ORIGIN_TRACE_ID);
    expect(stepDispatch.traceCarrier.traceparent).not.toBe(
      ORIGIN_CARRIER.traceparent
    );
  });
});
