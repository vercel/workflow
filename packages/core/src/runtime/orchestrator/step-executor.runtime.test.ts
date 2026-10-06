import type { Event, WorkflowRun } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import {
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from '../../serialization.js';
import {
  AppendOnlyWorld,
  type HeldMessage,
} from '../../test-support/append-only-world.js';
import { exceededMaxRetriesMessage } from '../step-executor.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// A background step whose invocations die mid-body (a function timeout
// hard-kills the body without writing an outcome). Each death leaves a
// `step_started` with nothing after it; the retry budget must still bound
// the step, because only the count of starts can.

const QUEUE = '__wkf_workflow_workflow';
const STEP = 'sx_timeout_prone';
const MAX_RETRIES = 1;

let bodyRuns = 0;
registerStepFunction(
  STEP,
  Object.assign(
    async () => {
      bodyRuns++;
      return 'ok';
    },
    { maxRetries: MAX_RETRIES }
  )
);

const WORKFLOW = `const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(STEP)});
  async function workflow() {
    try { return await step(); } catch (e) { return "failed: " + e.message; }
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

let currentEngine: 'node' | 'quickjs' = 'node';

async function setup() {
  const runId = `wrun_sx_${Math.random().toString(36).slice(2)}`;
  const world = new AppendOnlyWorld({ fence: true });
  world.seedRun({
    runId,
    workflowName: 'workflow',
    deploymentId: 'dpl_test',
    status: 'pending',
    executionContext: { workflowVm: currentEngine },
    input: await dehydrateWorkflowArguments([], runId, undefined, []),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as WorkflowRun);
  setWorld(world.asWorld());
  await workflowEntrypoint(WORKFLOW)(new Request('https://example.test'));
  world.enqueue(QUEUE, { runId, requestedAt: new Date() });
  // The orchestrator creates the step and enqueues its message.
  await world.deliver(world.held[0]!);
  const stepMessage = world.held.find(
    (held) => (held.message as { stepId?: string }).stepId !== undefined
  );
  expect(stepMessage).toBeDefined();
  return { world, runId, stepMessage: stepMessage! };
}

/** The step's invocation wrote `step_started` and then died. */
function dieAfterStart(world: AppendOnlyWorld, held: HeldMessage, n: number) {
  world.appendOutOfBand({
    eventType: 'step_started',
    correlationId: (held.message as { stepId: string }).stepId,
    eventData: {
      stepName: STEP,
      attempt: n,
      startReason: n === 1 ? 'first' : 'redelivery',
    },
  } as Partial<Event>);
}

const eventsOf = (world: AppendOnlyWorld, type: string) =>
  world.events.filter((event) => event.eventType === type);
const data = (event: Event | undefined) =>
  (event as { eventData?: Record<string, unknown> } | undefined)?.eventData;

async function runResult(world: AppendOnlyWorld, runId: string) {
  const completed = eventsOf(world, 'run_completed')[0];
  return hydrateWorkflowReturnValue(
    data(completed)?.output as Uint8Array,
    runId,
    undefined,
    []
  );
}

beforeEach(() => {
  bodyRuns = 0;
  vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
  setWorld(undefined);
});

describe.each([
  'node',
  'quickjs',
] as const)('background step retry budget across dead invocations (%s engine)', (engine) => {
  beforeEach(() => {
    currentEngine = engine;
  });

  it('runs the last allowed attempt after a dead invocation, as a redelivery', async () => {
    const { world, runId, stepMessage } = await setup();
    dieAfterStart(world, stepMessage, 1);
    await world.deliver({ ...stepMessage, deliveryCount: 2 });

    expect(bodyRuns).toBe(1);
    const starts = eventsOf(world, 'step_started');
    expect(starts.map((e) => data(e)?.attempt)).toEqual([1, 2]);
    expect(data(starts[1])?.startReason).toBe('redelivery');
    await world.runUntilIdle();
    expect(await runResult(world, runId)).toBe('ok');
  });

  it('fails the step without a body once every allowed attempt died', async () => {
    const { world, runId, stepMessage } = await setup();
    for (let n = 1; n <= MAX_RETRIES + 1; n++) {
      dieAfterStart(world, stepMessage, n);
    }
    const result = await world.deliver({
      ...stepMessage,
      deliveryCount: MAX_RETRIES + 2,
    });

    expect(result).toBeUndefined();
    expect(bodyRuns).toBe(0);
    expect(eventsOf(world, 'step_started')).toHaveLength(MAX_RETRIES + 1);
    const failed = eventsOf(world, 'step_failed');
    expect(failed).toHaveLength(1);
    expect(data(failed[0])).toMatchObject({ attempt: MAX_RETRIES + 2 });
    await world.runUntilIdle();
    expect(await runResult(world, runId)).toBe(
      `failed: ${exceededMaxRetriesMessage(STEP, MAX_RETRIES)}`
    );
  });
});
