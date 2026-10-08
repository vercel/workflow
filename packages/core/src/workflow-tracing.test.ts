import {
  context,
  trace as otelTrace,
  SpanStatusCode,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { Event, WorkflowRun } from '@workflow/world';
import {
  afterAll,
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from './serialization.js';
import { createContext } from './vm/index.js';
import { clearWorkflowScriptCache } from './vm/script-cache.js';
import { replayWorkflow, resumeWorkflow, runWorkflow } from './workflow.js';

vi.mock('./vm/index.js', async (importActual) => {
  const actual = await importActual<typeof import('./vm/index.js')>();
  return { ...actual, createContext: vi.fn(actual.createContext) };
});

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider();
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  otelTrace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  context.disable();
  otelTrace.disable();
});

beforeEach(() => {
  clearWorkflowScriptCache();
});

afterEach(() => {
  exporter.reset();
  vi.restoreAllMocks();
});

async function makeRun(): Promise<WorkflowRun> {
  const runId = 'wrun_trace_replay';
  return {
    runId,
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments(['hello'], runId, undefined, []),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    deploymentId: 'test-deployment',
  };
}

function spans(name: string) {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

const workflowCode = `
async function workflow(value) { return value; }
globalThis.__private_workflows = new Map();
globalThis.__private_workflows.set('workflow', workflow);
`;

describe('fresh replay tracing', () => {
  it('breaks workflow.run into blocking replay phases', async () => {
    const run = await makeRun();
    await runWorkflow(workflowCode, run, [], undefined);

    const allSpans = exporter.getFinishedSpans();
    const [workflowRun] = spans('workflow.run workflow');
    expect(workflowRun).toBeDefined();

    const childNames = allSpans
      .filter((span) => span.parentSpanId === workflowRun?.spanContext().spanId)
      .map((span) => span.name);
    expect(childNames).toEqual(
      expect.arrayContaining([
        'workflow.vm.create_context',
        'workflow.bundle.compile',
        'workflow.bundle.evaluate',
        'workflow.input.hydrate',
        'workflow.replay.execute',
      ])
    );
  });

  it('records VM bootstrap failures on the create-context span', async () => {
    vi.mocked(createContext).mockImplementationOnce(() => {
      throw new Error('test bootstrap failure');
    });

    await expect(
      runWorkflow(workflowCode, await makeRun(), [], undefined)
    ).rejects.toThrow('test bootstrap failure');

    expect(spans('workflow.vm.create_context')[0]?.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'test bootstrap failure',
    });
  });

  it('ends the replay span when workflow code throws null', async () => {
    const nullThrowingWorkflow = `
async function workflow() { throw null; }
globalThis.__private_workflows = new Map([['workflow', workflow]]);
`;

    await expect(
      runWorkflow(nullThrowingWorkflow, await makeRun(), [], undefined)
    ).rejects.toBeNull();

    expect(spans('workflow.replay.execute')[0]?.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'null',
    });
  });

  it('parents retained workflow continuations to the retained run', async () => {
    const run = await makeRun();
    const code = `const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step");
      async function workflow() { await step(); console.log("resumed"); }
      globalThis.__private_workflows = new Map([["workflow", workflow]]);
    `;
    const activeSpanIds: (string | undefined)[] = [];
    vi.spyOn(console, 'log').mockImplementation((message) => {
      if (message === 'resumed') {
        activeSpanIds.push(otelTrace.getActiveSpan()?.spanContext().spanId);
      }
    });

    const first = await replayWorkflow({
      workflowCode: code,
      workflowRun: run,
      events: [],
      encryptionKey: undefined,
      replayPayloadCache: new ReplayPayloadCache(undefined),
    });
    assert(first.type === 'suspended');
    expect(spans('workflow.replay.execute')).toHaveLength(1);
    const step = first.suspension.steps[0];
    assert(step?.type === 'step');
    const result = await dehydrateStepReturnValue(
      undefined,
      run.runId,
      undefined
    );

    const completed = await resumeWorkflow(first.session, [
      {
        eventId: 'event-step-completed',
        runId: run.runId,
        eventType: 'step_completed',
        correlationId: step.correlationId,
        eventData: { stepName: 'step', result },
        createdAt: run.updatedAt,
      },
    ] as Event[]);
    assert(completed.type === 'completed');

    expect(spans('workflow.replay.execute')).toHaveLength(1);
    const retainedRun = spans('workflow.run workflow').find(
      (span) => span.attributes['workflow.execution.mode'] === 'retained'
    );
    expect(activeSpanIds).toEqual([retainedRun?.spanContext().spanId]);
  });

  it('marks bundle compilation cache hits on later fresh replays', async () => {
    const run = await makeRun();
    await runWorkflow(workflowCode, run, [], undefined);
    await runWorkflow(workflowCode, run, [], undefined);

    const compileSpans = spans('workflow.bundle.compile');
    expect(compileSpans).toHaveLength(2);
    expect(
      compileSpans.map(
        (span) => span.attributes['workflow.bundle.compile.cache_hit']
      )
    ).toEqual([false, true]);
  });

  it('reports a bundle hit when only a different workflow lookup compiles', async () => {
    const firstName = 'workflow//./workflows/shared//first';
    const secondName = 'workflow//./workflows/shared//second';
    const sharedBundle = `
async function first(value) { return value; }
async function second(value) { return value; }
globalThis.__private_workflows = new Map();
globalThis.__private_workflows.set(${JSON.stringify(firstName)}, first);
globalThis.__private_workflows.set(${JSON.stringify(secondName)}, second);
`;
    const firstRun = { ...(await makeRun()), workflowName: firstName };
    const secondRun = { ...(await makeRun()), workflowName: secondName };

    await runWorkflow(sharedBundle, firstRun, [], undefined);
    await runWorkflow(sharedBundle, secondRun, [], undefined);

    const compileSpans = spans('workflow.bundle.compile');
    expect(
      compileSpans.map(
        (span) => span.attributes['workflow.bundle.compile.cache_hit']
      )
    ).toEqual([false, true]);
  });
});
