/**
 * Pins that the QuickJS engine repays a force-claim victim's wake on replay,
 * the way the node:vm suspension handler does.
 *
 * A forced `hook_created` is followed by a wake of the run it took the token
 * from. If the invocation dies between the two, the creation is in the log and
 * the victim was never told. Every later invocation inside the republish
 * window republishes the wake under the hook's idempotency key, whatever the
 * run wrote after the creation. `forcedCreationsOwingWake` is the shared rule;
 * this test drives the QuickJS entrypoint through it from a committed log,
 * with the VM mocked.
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
import { FORCE_CLAIM_WAKE_REPUBLISH_WINDOW_MS } from './hook-wake.js';
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
  correlationId?: string,
  createdAt: Date = new Date()
): Event =>
  ({
    eventType,
    eventId: slotToEventId(slot),
    runId,
    correlationId,
    createdAt,
    specVersion: SPEC_VERSION_CURRENT,
    eventData,
  }) as Event;

const forcedCreation = (slot: number, createdAt: Date = new Date()) =>
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
    'hook_claimer',
    createdAt
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
  it('republishes the wake for a recent forced creation', async () => {
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

  it("republishes past a delivery's hook_received", async () => {
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

  it("repays the wake even when the run's own step and wait rows landed after the forced creation", async () => {
    // vercel/workflow#4393: rows this run wrote after the creation (a step or
    // wait terminal from another invocation, or a row written alongside the
    // creation) do not say the wake was published.
    const queue = await replayWith([
      event(1, 'run_created', { workflowName: 'workflow', input: [] }),
      event(2, 'run_started'),
      forcedCreation(3),
      event(4, 'step_created', { stepName: 'after', input: [] }, 'step_after'),
      event(5, 'step_completed', { result: [] }, 'step_after'),
      event(6, 'wait_completed', {}, 'wait_1'),
    ]);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][2]).toMatchObject({
      idempotencyKey: 'hook-force-claim-hook_claimer',
    });
  });

  it("repays the victim's wake when a later claimer took the token from this run (the chain)", async () => {
    const queue = await replayWith([
      event(1, 'run_created', { workflowName: 'workflow', input: [] }),
      event(2, 'run_started'),
      forcedCreation(3),
      event(
        4,
        'hook_disposed',
        { forceClaimedBy: { runId: 'wrun_third', hookId: 'hook_third' } },
        'hook_claimer'
      ),
    ]);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][1]).toEqual({ runId: 'wrun_victim' });
  });

  it('stops republishing once the forced creation is outside the window', async () => {
    const queue = await replayWith([
      event(1, 'run_created', { workflowName: 'workflow', input: [] }),
      event(2, 'run_started'),
      forcedCreation(
        3,
        new Date(Date.now() - FORCE_CLAIM_WAKE_REPUBLISH_WINDOW_MS - 1_000)
      ),
    ]);
    expect(queue).not.toHaveBeenCalled();
  });

  it("does not hold the other writes for a forced creation's victim wake", async () => {
    // The wake still goes out, but the sibling hook and the wait are written
    // while it is in flight rather than after it. A crash before it goes out
    // is repaid by the next replay from the forced creation itself.
    const order: string[] = [];
    const queue = vi.fn(
      async (_queueName: string, message: { runId: string }) => {
        if (message.runId === runId) return { messageId: 'msg_continuation' };
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`wake:${message.runId}`);
        return { messageId: 'msg_wake' };
      }
    );
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

    const wakeAt = order.indexOf('wake:wrun_victim');
    expect(wakeAt).toBeGreaterThan(order.indexOf('hook_created:hook_forced'));
    expect(order.indexOf('hook_created:hook_plain')).toBeLessThan(wakeAt);
    expect(order.indexOf('wait_created:wait_1')).toBeLessThan(wakeAt);
    expect(order.filter((entry) => entry === 'wake:wrun_victim')).toHaveLength(
      1
    );
  });
});
