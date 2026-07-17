import { trace as otelTrace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { Event, WorkflowRun } from '@workflow/world';
import { monotonicFactory } from 'ulid';
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
import { WorkflowSuspension } from './global.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from './serialization.js';
import { createStepHydrationCache } from './step-hydration-cache.js';
import { createContext } from './vm/index.js';
import { clearWorkflowScriptCache } from './vm/script-cache.js';
import { runWorkflow } from './workflow.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider();

beforeAll(() => {
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  otelTrace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  otelTrace.disable();
});

beforeEach(() => {
  vi.stubEnv('VERCEL_URL', 'workflow-replay.test');
  clearWorkflowScriptCache();
});

afterEach(() => {
  exporter.reset();
  vi.unstubAllEnvs();
});

describe('workflow replay telemetry', () => {
  it('partitions VM work and aggregates replay work without per-step spans', async () => {
    const runId = 'wrun_replay_telemetry';
    const workflowName = 'workflow';
    const deploymentId = 'test-deployment';
    const startedAt = new Date('2024-01-01T00:00:00.000Z');
    const input = await dehydrateWorkflowArguments([3], runId, undefined);
    const workflowRun: WorkflowRun = {
      runId,
      workflowName,
      deploymentId,
      status: 'running',
      input,
      attributes: {},
      createdAt: startedAt,
      updatedAt: startedAt,
      startedAt,
    };

    const vm = createContext({
      seed: `${runId}:${workflowName}:${deploymentId}`,
      fixedTimestamp: +startedAt,
    });
    const ulid = monotonicFactory(() => vm.globalThis.Math.random());
    const events: Event[] = [
      {
        eventId: 'event-run-created',
        runId,
        eventType: 'run_created',
        eventData: { deploymentId, workflowName, input },
        createdAt: startedAt,
      },
      {
        eventId: 'event-run-started',
        runId,
        eventType: 'run_started',
        createdAt: startedAt,
      },
    ];

    for (let i = 0; i < 2; i++) {
      const correlationId = `step_${ulid(+startedAt)}`;
      events.push(
        {
          eventId: `event-${i}-created`,
          runId,
          eventType: 'step_created',
          correlationId,
          eventData: { stepName: 'timedNoopStep', input: undefined },
          createdAt: startedAt,
        },
        {
          eventId: `event-${i}-started`,
          runId,
          eventType: 'step_started',
          correlationId,
          eventData: { stepName: 'timedNoopStep' },
          createdAt: startedAt,
        },
        {
          eventId: `event-${i}-completed`,
          runId,
          eventType: 'step_completed',
          correlationId,
          eventData: {
            stepName: 'timedNoopStep',
            result: await dehydrateStepReturnValue(
              { start: i, end: i },
              runId,
              undefined
            ),
          },
          createdAt: startedAt,
        }
      );
    }

    const workflowCode = `
      const timedNoopStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("timedNoopStep");
      async function workflow(count) {
        for (let i = 0; i < count; i++) await timedNoopStep(i);
      }
      globalThis.__private_workflows = new Map([["workflow", workflow]]);
    `;

    await expect(
      runWorkflow(
        workflowCode,
        workflowRun,
        events,
        undefined,
        createStepHydrationCache()
      )
    ).rejects.toSatisfy((error) => WorkflowSuspension.is(error));

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((span) => span.name === 'workflow.run workflow');
    const execute = spans.find((span) => span.name === 'workflow.run.execute');
    const evaluate = spans.find(
      (span) => span.name === 'workflow.run.vm.evaluate_bundle'
    );
    const lookup = spans.find(
      (span) => span.name === 'workflow.run.vm.lookup_function'
    );

    expect(parent).toBeDefined();
    expect(execute).toBeDefined();
    expect(evaluate?.attributes['workflow.vm.script_cache.hit']).toBe(false);
    expect(lookup?.attributes['workflow.vm.script_cache.hit']).toBe(false);
    expect(parent?.attributes['workflow.run.setup.duration_ms']).toEqual(
      expect.any(Number)
    );
    expect(execute?.attributes).toMatchObject({
      'workflow.replay.events.consumed': 8,
      'workflow.replay.steps.completed': 2,
      'workflow.replay.steps.hydration.cache_hits': 0,
      'workflow.replay.steps.hydration.cache_misses': 2,
      'workflow.replay.steps.hydration.cache_unavailable': 0,
      'workflow.replay.steps.hydration.non_memoizable': 2,
    });
    expect(
      execute?.attributes['workflow.replay.events.callback_invocations']
    ).toEqual(expect.any(Number));
    expect(
      execute?.attributes['workflow.replay.events.consume_ms'] as number
    ).toBeGreaterThanOrEqual(0);
    expect(
      execute?.attributes['workflow.replay.steps.hydration_ms'] as number
    ).toBeGreaterThanOrEqual(0);
    expect(
      execute?.attributes[
        'workflow.replay.steps.hydration.decrypt_ms'
      ] as number
    ).toBeGreaterThanOrEqual(0);
    expect(
      execute?.attributes[
        'workflow.replay.steps.hydration.decompress_ms'
      ] as number
    ).toBeGreaterThanOrEqual(0);
    expect(
      execute?.attributes[
        'workflow.replay.steps.hydration.telemetry_ms'
      ] as number
    ).toBeGreaterThanOrEqual(0);
    expect(
      execute?.attributes[
        'workflow.replay.steps.hydration.deserialize_ms'
      ] as number
    ).toBeGreaterThanOrEqual(0);

    expect(spans.map((span) => span.name)).toEqual(
      expect.arrayContaining([
        'workflow.run.vm.create_context',
        'workflow.run.vm.evaluate_bundle',
        'workflow.run.vm.lookup_function',
        'workflow.run.hydrate_arguments',
        'workflow.run.execute',
      ])
    );
    expect(
      spans.filter((span) => span.name.startsWith('workflow.replay.step'))
    ).toHaveLength(0);
  });
});
