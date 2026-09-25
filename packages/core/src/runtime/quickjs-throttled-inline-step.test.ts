import {
  type CreateEventRequest,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, expect, it, vi } from 'vitest';
import { MAX_RESILIENT_STEP_INPUT_BYTES } from './constants.js';
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
 * One QuickJS invocation whose only pending op is a fresh step (no
 * `step_created` yet, so it runs as a lazy inline claim), with the claim
 * answered `throttled`: the lazy `step_started` was rejected with a 429, so
 * the step was never created.
 */
async function runThrottledInlineStep(input: Uint8Array) {
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
    runs: { get: async () => workflowRun },
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
        pendingOperations: [
          {
            type: 'step',
            correlationId: stepId,
            stepId: 'step//throttled//run',
            input,
            hasCreatedEvent: false,
          },
        ],
      },
    },
    continueWithEvents: vi.fn(),
    dispose: vi.fn(),
  }));
  vi.mocked(executeStep).mockResolvedValue({
    type: 'throttled',
    timeoutSeconds: 5,
  });

  await runWorkflowWithQuickJS({
    workflowCode: '',
    workflowName: workflowRun.workflowName,
    workflowRun,
  });

  const stepMessages = queued.filter((q) => q.payload?.stepId === stepId);
  return { created, stepMessages };
}

it('carries the input on the retry message of a throttled lazy inline claim', async () => {
  // Regression: the retry message used to be input-less. The step was never
  // created, so the consumer's bare `step_started` failed "step not found"
  // on every delivery until the delivery ceiling, with no input on the
  // message to materialize the step from.
  const input = new Uint8Array([1, 2, 3, 4]);
  const { created, stepMessages } = await runThrottledInlineStep(input);

  expect(executeStep).toHaveBeenCalledTimes(1);
  expect(vi.mocked(executeStep).mock.calls[0][0].lazyStepInput).toEqual(input);
  expect(stepMessages).toHaveLength(1);
  expect(stepMessages[0].payload.stepInput).toEqual({ input });
  expect(stepMessages[0].opts).toMatchObject({
    delaySeconds: 5,
    idempotencyKey: `${stepId}:retry:1`,
  });
  // The message is the recovery path: no extra write under a throttle.
  expect(created.map((e) => e.eventType)).not.toContain('step_created');
});

it('materializes the step before queueing when the input is too large for the message', async () => {
  const input = new Uint8Array(MAX_RESILIENT_STEP_INPUT_BYTES + 1).fill(7);
  const { created, stepMessages } = await runThrottledInlineStep(input);

  const stepCreated = created.filter((e) => e.eventType === 'step_created');
  expect(stepCreated).toHaveLength(1);
  expect(stepCreated[0]).toMatchObject({
    correlationId: stepId,
    eventData: { stepName: 'step//throttled//run', input },
  });
  expect(stepMessages).toHaveLength(1);
  expect(stepMessages[0].payload).not.toHaveProperty('stepInput');
});
