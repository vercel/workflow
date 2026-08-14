import { context, trace as otelTrace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { WorkflowRun } from '@workflow/world';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { dehydrateWorkflowArguments } from './serialization.js';
import { clearWorkflowScriptCache } from './vm/script-cache.js';
import { runWorkflow } from './workflow.js';

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

const workflowCode = `
async function workflow(value) { return value; }
globalThis.__private_workflows = new Map();
globalThis.__private_workflows.set('workflow', workflow);
`;

describe('fresh replay tracing', () => {
  it('breaks workflow.run into blocking replay phases', async () => {
    const run = await makeRun();
    await runWorkflow(workflowCode, run, [], undefined);

    const spans = exporter.getFinishedSpans();
    const workflowRun = spans.find(
      (span) => span.name === 'workflow.run workflow'
    );
    expect(workflowRun).toBeDefined();

    const childNames = spans
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

  it('marks bundle compilation cache hits on later fresh replays', async () => {
    const run = await makeRun();
    await runWorkflow(workflowCode, run, [], undefined);
    await runWorkflow(workflowCode, run, [], undefined);

    const compileSpans = exporter
      .getFinishedSpans()
      .filter((span) => span.name === 'workflow.bundle.compile');
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

    const compileSpans = exporter
      .getFinishedSpans()
      .filter((span) => span.name === 'workflow.bundle.compile');
    expect(
      compileSpans.map(
        (span) => span.attributes['workflow.bundle.compile.cache_hit']
      )
    ).toEqual([false, true]);
  });
});
