import {
  type CreateEventRequest,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, expect, it, vi } from 'vitest';
import { runWorkflowWithQuickJS } from './quickjs-entrypoint.js';
import { startQuickJSWorkflow } from './quickjs-runtime.js';
import { executeStep } from './step-executor.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({ getPortLazy: async () => 3000 }));
vi.mock('./quickjs-runtime.js', () => ({ startQuickJSWorkflow: vi.fn() }));
vi.mock('./step-executor.js', () => ({ executeStep: vi.fn() }));

afterEach(() => {
  setWorld(undefined);
  vi.clearAllMocks();
  vi.mocked(executeStep).mockReset();
});

const runId = 'wrun_quickjs_throttled';
const stepId = 'step_quickjs_throttled';
const now = new Date('2026-05-19T12:00:00.000Z');
const workflowRun: WorkflowRun = {
  runId,
  workflowName: 'workflow',
  status: 'running',
  input: [],
  deploymentId: 'dpl_quickjs_throttled',
  specVersion: SPEC_VERSION_CURRENT,
  startedAt: now,
  createdAt: now,
  updatedAt: now,
};

/**
 * One QuickJS invocation whose pending ops are fresh steps (no
 * `step_created` yet, so they run as lazy inline claims). By default the
 * claim is answered `throttled`: the lazy `step_started` was rejected with a
 * 429, so the step was never created.
 */
async function runThrottledInlineStep(
  input: Uint8Array,
  pending: { correlationId: string; stepId: string }[] = [
    { correlationId: stepId, stepId: 'step//throttled//run' },
  ]
) {
  const run = workflowRun;
  const created: CreateEventRequest[] = [];
  const queued: { payload: any; opts: any }[] = [];
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {},
    events: {
      list: async () => ({ data: [], cursor: null, hasMore: false }),
      create: async (_runId: string, request: CreateEventRequest) => {
        created.push(request);
        return { event: { ...request, runId, eventId: 'evnt_1' } };
      },
    },
    runs: { get: async () => run },
    queue: async (_queueName: string, payload: unknown, opts: unknown) => {
      queued.push({ payload, opts });
      return { messageId: null };
    },
    getDeploymentId: async () => workflowRun.deploymentId,
    getEncryptionKeyForRun: async () => undefined,
  } as unknown as World);

  vi.mocked(startQuickJSWorkflow).mockImplementation(async () => ({
    result: {
      suspended: {
        pendingOperations: pending.map((p) => ({
          type: 'step',
          ...p,
          input,
          hasCreatedEvent: false,
        })),
      },
    },
    continueWithEvents: vi.fn(),
    dispose: vi.fn(),
  }));
  if (!vi.mocked(executeStep).getMockImplementation()) {
    vi.mocked(executeStep).mockResolvedValue({
      type: 'throttled',
      timeoutSeconds: 5,
    });
  }

  await runWorkflowWithQuickJS({
    workflowCode: '',
    workflowName: run.workflowName,
    workflowRun: run,
  });

  const stepMessages = queued.filter((q) => q.payload?.stepId !== undefined);
  const replays = queued.filter((q) => q.payload?.stepId === undefined);
  return { created, stepMessages, replays };
}

it('defers a fresh replay instead of queueing a throttled lazy inline step', async () => {
  // Regression: the throttled step used to be handed to the queue as an
  // input-less background step. The step was never created, so the
  // consumer's bare `step_started` failed "step not found" on every delivery
  // until the delivery ceiling. Like the node engine, the orchestrator is
  // re-invoked after the backoff instead, and its replay re-runs the step
  // inline with its input.
  const input = new Uint8Array([1, 2, 3, 4]);
  const { created, stepMessages, replays } =
    await runThrottledInlineStep(input);

  expect(executeStep).toHaveBeenCalledTimes(1);
  expect(stepMessages).toHaveLength(0);
  expect(replays).toHaveLength(1);
  expect(replays[0].payload).toMatchObject({ runId });
  expect(replays[0].payload).not.toHaveProperty('hookInput');
  expect(replays[0].opts).toMatchObject({ delaySeconds: 5 });
  // No write under the throttle: the replay's lazy claim creates the step.
  expect(created.map((e) => e.eventType)).not.toContain('step_created');
});

it('defers by the longest backoff and still queues a sibling retry', async () => {
  const input = new Uint8Array([1]);
  const pending = [
    { correlationId: 'step_a', stepId: 'step//a' },
    { correlationId: 'step_b', stepId: 'step//b' },
    { correlationId: 'step_c', stepId: 'step//c' },
  ];
  vi.mocked(executeStep).mockImplementation(async ({ stepId: cid }) =>
    cid === 'step_a'
      ? { type: 'throttled', timeoutSeconds: 3 }
      : cid === 'step_b'
        ? { type: 'throttled', timeoutSeconds: 9 }
        : { type: 'retry', timeoutSeconds: 2 }
  );
  const { stepMessages, replays } = await runThrottledInlineStep(
    input,
    pending
  );

  expect(executeStep).toHaveBeenCalledTimes(3);
  // The retrying step exists (its start succeeded): it keeps its own message.
  expect(stepMessages.map((m) => m.payload.stepId)).toEqual(['step_c']);
  expect(stepMessages[0].opts).toMatchObject({ delaySeconds: 2 });
  expect(replays).toHaveLength(1);
  expect(replays[0].opts).toMatchObject({ delaySeconds: 9 });
});
