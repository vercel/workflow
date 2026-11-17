/**
 * A `Promise.race` loser still running when the run ends (early advance lets
 * the run finish without it) must not hold up the run's end, whatever its
 * retention: `Promise.race([oneMinuteStep(), thirtyMinuteStep()])` ends after
 * one minute. For an `experimental_retention: 0` run, what the loser writes
 * after the purge is discarded by the World.
 */
import {
  type Event,
  RETENTION_ATTRIBUTE,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateWorkflowArguments } from '../../serialization.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
}));

const QUEUE_NAME = '__wkf_workflow_workflow';
const WINNER = 'zeroRetentionRaceWinner';
const LOSER = 'zeroRetentionRaceLoser';

let releaseLoser!: () => void;
let loserReleased = new Promise<void>((resolve) => {
  releaseLoser = resolve;
});
registerStepFunction(WINNER, async () => 'winner');
registerStepFunction(LOSER, async () => {
  await loserReleased;
  return 'loser';
});

/** One orchestrator delivery of a run racing `WINNER` against `LOSER`. */
async function raceRun(attributes: Record<string, string>) {
  const runId = `wrun_zero_retention_${Date.now()}`;
  const startedAt = new Date('2024-01-01T00:00:00.000Z');
  const workflowRun: WorkflowRun = {
    runId,
    workflowName: 'workflow',
    status: 'running',
    specVersion: SPEC_VERSION_CURRENT,
    input: await dehydrateWorkflowArguments([], runId, undefined, []),
    attributes,
    createdAt: startedAt,
    updatedAt: startedAt,
    startedAt,
    deploymentId: 'test-deployment',
  };
  let seq = 1;
  const durable: Event[] = [
    {
      eventId: slotToEventId(seq),
      runId,
      createdAt: startedAt,
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'test-deployment',
        workflowName: 'workflow',
        input: workflowRun.input,
        attributes,
      },
    } as unknown as Event,
  ];
  const record = (data: any): Event => {
    seq += 1;
    const event = {
      eventId: slotToEventId(seq),
      runId,
      createdAt: new Date(),
      ...data,
    } as Event;
    durable.push(event);
    return event;
  };
  const stepNames = new Map<string, string>();
  const stepInputs = new Map<string, unknown>();

  let handler!: (message: unknown, metadata: unknown) => Promise<unknown>;
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    createQueueHandler: vi.fn((_prefix: string, h: typeof handler) => {
      handler = h;
      return async () => new Response(null, { status: 204 });
    }),
    events: {
      create: vi.fn(async (_runId: string, data: any) => {
        if (data.eventType === 'run_started') {
          return { run: workflowRun, events: [...durable] };
        }
        if (data.eventType === 'step_started') {
          const id = data.correlationId;
          if (data.eventData?.stepName)
            stepNames.set(id, data.eventData.stepName);
          if (!stepInputs.has(id)) stepInputs.set(id, data.eventData?.input);
          return {
            event: record(data),
            step: {
              runId,
              stepId: id,
              stepName: stepNames.get(id),
              status: 'running' as const,
              attempt: 1,
              input: stepInputs.get(id),
              startedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          };
        }
        if (data.eventType === 'run_completed') {
          workflowRun.status = 'completed';
        }
        return { event: record(data) };
      }),
      list: vi.fn(async () => ({
        data: [...durable],
        hasMore: false,
        cursor: 'cursor_test',
      })),
    },
    runs: { get: vi.fn(async () => workflowRun) },
    queue: vi.fn(async () => ({ messageId: `msg_${seq}` })),
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  const entry = workflowEntrypoint(`
    const winner = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("${WINNER}");
    const loser = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("${LOSER}");
    async function workflow() {
      return await Promise.race([loser(), winner()]);
    };globalThis.__private_workflows = new Map();
    globalThis.__private_workflows.set("workflow", workflow);`);
  await entry(new Request('https://example.test'));

  const delivery = handler(
    { runId, requestedAt: new Date() },
    {
      requestId: 'req_flow',
      attempt: 1,
      queueName: QUEUE_NAME,
      messageId: 'msg_flow',
    }
  );
  const types = () => durable.map((event) => event.eventType);
  const loserCompleted = () =>
    durable.some(
      (event) =>
        event.eventType === 'step_completed' &&
        stepNames.get(event.correlationId as string) === LOSER
    );
  return { delivery, types, loserCompleted };
}

describe('a Promise.race loser still running when the run ends', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.restoreAllMocks();
    loserReleased = new Promise<void>((resolve) => {
      releaseLoser = resolve;
    });
  });

  it('does not hold up the end of a run that keeps its data', async () => {
    const run = await raceRun({});
    await vi.waitFor(() => expect(run.types()).toContain('run_completed'));
    expect(run.loserCompleted()).toBe(false);
    releaseLoser();
    await run.delivery;
    // Its body still finishes before the delivery returns.
    expect(run.loserCompleted()).toBe(true);
  });

  // Regression: a zero-retention run must end when its race is decided, as a
  // default run does. Holding `run_completed` until the loser settles makes
  // `Promise.race([oneMinuteStep(), thirtyMinuteStep()])` take 30 minutes
  // (and, past the function's lifetime, re-runs the loser on redelivery).
  // Late writes after the purge are the World's to discard, not a reason to
  // delay the run's end.
  it('does not hold up the end of a zero-retention run either', async () => {
    const run = await raceRun({ [RETENTION_ATTRIBUTE]: '0' });
    try {
      await vi.waitFor(() => expect(run.types()).toContain('run_completed'), {
        timeout: 2_000,
      });
      expect(run.loserCompleted()).toBe(false);
    } finally {
      releaseLoser();
      await run.delivery;
    }
    // Its body still finishes before the delivery returns.
    expect(run.loserCompleted()).toBe(true);
  });
});
