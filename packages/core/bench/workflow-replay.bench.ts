import type { Event, WorkflowRun } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { bench, describe } from 'vitest';
import { WorkflowSuspension } from '../src/global.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from '../src/serialization.js';
import {
  createStepHydrationCache,
  type StepHydrationCache,
} from '../src/step-hydration-cache.js';
import { createContext } from '../src/vm/index.js';
import { runWorkflow } from '../src/workflow.js';

/**
 * Isolated replay benchmark: no World, queue, workflow-server, or storage.
 * Run from the repository root with:
 * `pnpm vitest bench packages/core/bench/workflow-replay.bench.ts --run`
 */

type ResultMode = 'object-miss' | 'primitive-miss' | 'primitive-hit';

interface ReplayFixture {
  workflowRun: WorkflowRun;
  events: Event[];
  initialCache: StepHydrationCache;
}

const workflowCode = `
  const timedNoopStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("timedNoopStep");
  async function workflow(count) {
    for (let i = 0; i < count; i++) await timedNoopStep(i);
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);
`;

async function createReplayFixture(
  completedSteps: number,
  resultMode: ResultMode
): Promise<ReplayFixture> {
  const runId = `wrun_bench_${completedSteps}_${resultMode}`;
  const workflowName = 'workflow';
  const deploymentId = 'local-benchmark';
  const startedAt = new Date('2024-01-01T00:00:00.000Z');
  const input = await dehydrateWorkflowArguments(
    [completedSteps + 1],
    runId,
    undefined
  );
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
  const initialCache = createStepHydrationCache();
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

  for (let i = 0; i < completedSteps; i++) {
    const correlationId = `step_${ulid(+startedAt)}`;
    const completedEventId = `event-${i}-completed`;
    const result = resultMode === 'object-miss' ? { start: i, end: i } : i;
    if (resultMode === 'primitive-hit') {
      initialCache.set(completedEventId, result);
    }
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
        eventId: completedEventId,
        runId,
        eventType: 'step_completed',
        correlationId,
        eventData: {
          stepName: 'timedNoopStep',
          result: await dehydrateStepReturnValue(result, runId, undefined),
        },
        createdAt: startedAt,
      }
    );
  }

  return { workflowRun, events, initialCache };
}

process.env.VERCEL_URL = 'local-replay-benchmark.test';

const fixtures = new Map<string, ReplayFixture>();
for (const completedSteps of [20, 120, 1020]) {
  for (const resultMode of [
    'object-miss',
    'primitive-miss',
    'primitive-hit',
  ] as const) {
    fixtures.set(
      `${completedSteps}:${resultMode}`,
      await createReplayFixture(completedSteps, resultMode)
    );
  }
}

describe('runWorkflow sequential replay scaling', () => {
  for (const completedSteps of [20, 120, 1020]) {
    for (const resultMode of [
      'object-miss',
      'primitive-miss',
      'primitive-hit',
    ] as const) {
      bench(`${completedSteps} completed steps / ${resultMode}`, async () => {
        const fixture = fixtures.get(`${completedSteps}:${resultMode}`);
        if (!fixture) throw new Error('Missing replay benchmark fixture');
        const cache = new Map(fixture.initialCache);
        try {
          await runWorkflow(
            workflowCode,
            fixture.workflowRun,
            fixture.events,
            undefined,
            cache
          );
          throw new Error('Expected workflow replay to suspend');
        } catch (error) {
          if (!WorkflowSuspension.is(error)) throw error;
        }
      });
    }
  }
});
