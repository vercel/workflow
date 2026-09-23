/**
 * Pins that the QuickJS engine repays a force-claim victim's wake on replay,
 * the way the node:vm suspension handler does.
 *
 * A forced `hook_created` is followed by a wake of the run it took the token
 * from. If the invocation dies between the two, the creation is in the log and
 * the victim was never told. On the next invocation the row is still the last
 * event this run wrote, so the entrypoint republishes the wake — before the VM
 * runs and before anything is written — under the hook's idempotency key.
 * `forcedCreationOwingWake` is the shared rule; this test drives the QuickJS
 * entrypoint through it from a committed log, with the VM mocked.
 */
import {
  type CreateEventRequest,
  type Event,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({
  getPortLazy: vi.fn().mockResolvedValue(3000),
}));

const startQuickJSWorkflow = vi.fn();
vi.mock('./quickjs-runtime.js', () => ({
  startQuickJSWorkflow: (...args: unknown[]) => startQuickJSWorkflow(...args),
}));

const runId = 'wrun_claimer_qjs';
const startedAt = new Date('2026-09-17T12:00:00.000Z');
const workflowRun: WorkflowRun = {
  runId,
  workflowName: 'workflow',
  status: 'running',
  input: [],
  deploymentId: 'dpl_claimer',
  specVersion: SPEC_VERSION_CURRENT,
  startedAt,
  createdAt: startedAt,
  updatedAt: startedAt,
};

const event = (
  slot: number,
  eventType: Event['eventType'],
  eventData?: unknown,
  correlationId?: string
): Event =>
  ({
    eventType,
    eventId: slotToEventId(slot),
    runId,
    correlationId,
    createdAt: startedAt,
    specVersion: SPEC_VERSION_CURRENT,
    eventData,
  }) as Event;

const forcedCreation = (slot: number) =>
  event(
    slot,
    'hook_created',
    {
      token: 'channel:1',
      force: true,
      forceClaimedFrom: {
        runId: 'wrun_victim',
        hookId: 'hook_victim',
        workflowName: 'victim-workflow',
        deploymentId: 'dpl_victim',
        runSpecVersion: SPEC_VERSION_CURRENT,
      },
    },
    'hook_claimer'
  );

/** Replay the entrypoint over a committed log; the VM suspends with nothing pending. */
async function replayWith(events: Event[]) {
  const queue = vi.fn().mockResolvedValue({ messageId: 'msg_wake' });
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {},
    events: {
      list: vi.fn(async () => ({ data: events, cursor: null, hasMore: false })),
      create: vi.fn(),
    },
    runs: { get: vi.fn(async () => workflowRun) },
    queue,
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World);

  startQuickJSWorkflow.mockResolvedValue({
    result: { suspended: { pendingOperations: [] } },
    continueWithEvents: vi.fn(),
    dispose: vi.fn(),
  });

  const { runWorkflowWithQuickJS } = await import('./quickjs-entrypoint.js');
  await runWorkflowWithQuickJS({
    workflowCode: '// not evaluated: the VM is mocked',
    workflowName: 'workflow',
    workflowRun,
    preloadedEvents: events,
    preloadedEventsComplete: true,
  });
  return queue;
}

describe('QuickJS force-claim victim wake on replay', () => {
  it('republishes the wake when the forced creation is the last event this run wrote', async () => {
    const queue = await replayWith([
      event(1, 'run_created', { workflowName: 'workflow', input: [] }),
      event(2, 'run_started'),
      forcedCreation(3),
    ]);
    expect(queue).toHaveBeenCalledTimes(1);
    const [queueName, message, options] = queue.mock.calls[0];
    expect(queueName).toContain('victim-workflow');
    expect(message).toEqual({ runId: 'wrun_victim' });
    expect(options).toMatchObject({
      deploymentId: 'dpl_victim',
      idempotencyKey: 'hook-force-claim-hook_claimer',
    });
  });

  it("still republishes past a delivery's hook_received, which is not this run's progress", async () => {
    const queue = await replayWith([
      event(1, 'run_created', { workflowName: 'workflow', input: [] }),
      event(2, 'run_started'),
      forcedCreation(3),
      event(
        4,
        'hook_received',
        { token: 'channel:1', payload: new Uint8Array() },
        'hook_claimer'
      ),
    ]);
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('stops once this run has written anything after the creation', async () => {
    const queue = await replayWith([
      event(1, 'run_created', { workflowName: 'workflow', input: [] }),
      event(2, 'run_started'),
      forcedCreation(3),
      event(4, 'step_created', { stepName: 'after', input: [] }, 'step_after'),
    ]);
    expect(queue).not.toHaveBeenCalled();
  });

  it('writes nothing else between a forced creation and its victim wake', async () => {
    // Every pending op is dispatched in parallel in this engine, so a step,
    // wait or other hook row could land after the forced `hook_created`
    // while the wake is in flight; a crash then would leave that row as the
    // tail and the replay above would never repay the wake.
    const order: string[] = [];
    const queue = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('wake:wrun_victim');
      return { messageId: 'msg_wake' };
    });
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      capabilities: { hookForceClaim: true },
      events: {
        list: vi.fn(async () => ({ data: [], cursor: null, hasMore: false })),
        create: vi.fn(async (_runId: string, request: CreateEventRequest) => {
          order.push(`${request.eventType}:${request.correlationId}`);
          return {
            event: { ...request, runId, eventId: 'evnt_created' },
            ...(request.correlationId === 'hook_forced' && {
              hook: {
                hookId: 'hook_forced',
                claimedFrom: {
                  runId: 'wrun_victim',
                  hookId: 'hook_victim',
                  workflowName: 'victim-workflow',
                },
              },
            }),
          };
        }),
      },
      runs: { get: vi.fn(async () => workflowRun) },
      queue,
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as World);
    startQuickJSWorkflow.mockResolvedValue({
      result: {
        suspended: {
          pendingOperations: [
            {
              type: 'wait',
              correlationId: 'wait_1',
              resumeAt: Date.now() + 60 * 60 * 1000,
              hasCreatedEvent: false,
            },
            {
              type: 'hook',
              correlationId: 'hook_plain',
              token: 'plain-token',
              isWebhook: false,
              hasCreatedEvent: false,
            },
            {
              type: 'hook',
              correlationId: 'hook_forced',
              token: 'forced-token',
              isWebhook: false,
              force: true,
              hasCreatedEvent: false,
            },
          ],
        },
      },
      continueWithEvents: vi.fn(),
      dispose: vi.fn(),
    });

    const { runWorkflowWithQuickJS } = await import('./quickjs-entrypoint.js');
    await runWorkflowWithQuickJS({
      workflowCode: '// not evaluated: the VM is mocked',
      workflowName: 'workflow',
      workflowRun,
      preloadedEvents: [],
    });

    expect(order.slice(0, 2)).toEqual([
      'hook_created:hook_forced',
      'wake:wrun_victim',
    ]);
    expect(order).toContain('hook_created:hook_plain');
    expect(order).toContain('wait_created:wait_1');
  });
});
