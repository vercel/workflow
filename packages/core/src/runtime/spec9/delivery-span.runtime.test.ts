import { trace as otelTrace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
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
import { registerStepFunction } from '../../private.js';
import * as Attribute from '../../telemetry/semantic-conventions.js';
import {
  registerWorkflow,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// The `workflow.execute` span says why a spec 9 delivery ended early.

const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider();

beforeAll(() => {
  tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));
  otelTrace.setGlobalTracerProvider(tracerProvider);
});

afterAll(async () => {
  await tracerProvider.shutdown();
  otelTrace.disable();
});

beforeEach(() => {
  spanExporter.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Moves `Date.now()` past every invocation deadline while a body runs. */
let clockOffsetMs = 0;
const realNow = Date.now.bind(Date);
registerStepFunction('span_add', async (a: number, b: number) => a + b);
registerStepFunction('span_slow_add', async (a: number, b: number) => {
  clockOffsetMs += 30 * 60_000;
  return a + b;
});

const key = (attribute: Record<string, unknown>) => Object.keys(attribute)[0]!;
const EXIT_REASON = key(Attribute.WorkflowDeliveryExitReason(''));
const HANDOFF = key(Attribute.WorkflowDeliveryHandoff(false));

const executeSpans = (): ReadableSpan[] =>
  spanExporter
    .getFinishedSpans()
    .filter((span) => span.name.startsWith('workflow.execute'));

describe('workflow.execute span', () => {
  it('records a deadline handoff', async () => {
    vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', '0');
    const { world, start } = await setupOrchestratorRun(
      `const slow = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("span_slow_add");
       const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("span_add");
       async function workflow(a, b) {
         const first = await slow(a, b);
         return await add(first, 10);
       }${registerWorkflow()}`,
      [1, 2]
    );
    clockOffsetMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffsetMs);
    expect(await world.deliver(start)).toEqual({ timeoutSeconds: 0 });
    vi.restoreAllMocks();

    const [first] = executeSpans();
    expect(first?.attributes[EXIT_REASON]).toBe('deadline');
    expect(first?.attributes[HANDOFF]).toBe(true);
  });
});
