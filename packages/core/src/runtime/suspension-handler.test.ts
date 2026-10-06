import { runInNewContext } from 'node:vm';
import {
  EntityConflictError,
  FatalError,
  PreconditionFailedError,
  RunExpiredError,
  WorkflowWorldError,
} from '@workflow/errors';
import type { Event } from '@workflow/world';
import {
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type ValidQueueName,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type QueueItem, WorkflowSuspension } from '../global.js';
import { hydrateStepArguments, hydrateStepError } from '../serialization.js';
import { COMPUTE_INSTANCE_ID } from './compute-instance.js';
import { maxEventSlot, stepDispatchIdempotencyKey } from './helpers.js';
import { FORCE_CLAIM_WAKE_REPUBLISH_WINDOW_MS } from './hook-wake.js';
import { ReplayRecoveryReporter } from './replay-recovery-reporter.js';
import { handleSuspension } from './suspension-handler.js';
import { isUnserializableStepInputPlaceholder } from './unserializable-step.js';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

const run: WorkflowRun = {
  runId: 'wrun_123',
  workflowName: 'test-workflow',
  status: 'running',
  input: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  startedAt: new Date(),
  deploymentId: 'test-deployment',
};

function createWorld(eventsCreate: ReturnType<typeof vi.fn>): World {
  return {
    events: {
      create: eventsCreate,
    },
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World;
}

describe('handleSuspension', () => {
  it('stamps recovery telemetry on a suspension write', async () => {
    // Covers the wiring, not the claim mechanics (see
    // replay-recovery-reporter.test.ts): an activated reporter reaching
    // handleSuspension must actually reach its event writes.
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event,
    }));
    const world = createWorld(eventsCreate);
    const reporter = new ReplayRecoveryReporter(2);
    reporter.activate();
    const pending = new Map([
      [
        'hook_recovered',
        {
          type: 'hook' as const,
          correlationId: 'hook_recovered',
          token: 'order:123',
        },
      ],
    ]);

    await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
      replayRecoveryReporter: reporter,
    });

    expect(eventsCreate).toHaveBeenCalledWith(
      run.runId,
      expect.objectContaining({ eventType: 'hook_created' }),
      expect.objectContaining({ replayDivergenceCount: 2 })
    );
  });

  it('persists the token retention deadline on hook_created', async () => {
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event,
    }));
    const world = createWorld(eventsCreate);
    const tokenRetentionUntil = new Date('2026-08-01T00:00:00.000Z');
    const pending = new Map([
      [
        'hook_with_retention',
        {
          type: 'hook' as const,
          correlationId: 'hook_with_retention',
          token: 'order:123',
          tokenRetentionUntil,
        },
      ],
    ]);

    await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    expect(eventsCreate).toHaveBeenCalledWith(
      run.runId,
      expect.objectContaining({
        eventType: 'hook_created',
        eventData: expect.objectContaining({
          token: 'order:123',
          tokenRetentionUntil,
        }),
      }),
      expect.anything()
    );
  });

  it('fails the run when the World rejects Hook retention', async () => {
    const worldError = new WorkflowWorldError('Retention exceeds 30 days', {
      status: 400,
    });
    const world = createWorld(vi.fn().mockRejectedValue(worldError));
    const pending = new Map([
      [
        'hook_with_invalid_retention',
        {
          type: 'hook' as const,
          correlationId: 'hook_with_invalid_retention',
          token: 'order:123',
          tokenRetentionUntil: new Date('2026-09-01T00:00:00.000Z'),
        },
      ],
    ]);

    await expect(
      handleSuspension({
        suspension: new WorkflowSuspension(pending, globalThis),
        world,
        run,
      })
    ).rejects.toMatchObject({
      name: FatalError.name,
      message: 'createHook failed World validation: Retention exceeds 30 days',
      cause: worldError,
    });
  });

  it('marks hook.getConflict()-awaited creations without converting them into wait timeouts', async () => {
    const eventsCreate = vi.fn().mockResolvedValue({
      event: {
        eventType: 'hook_created',
      },
    });
    const world = createWorld(eventsCreate);
    const pending = new Map([
      [
        'hook_awaited',
        {
          type: 'hook' as const,
          correlationId: 'hook_awaited',
          token: 'claim-token',
          hasConflictAwaiter: true,
        },
      ],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    expect(eventsCreate).toHaveBeenCalledWith(
      run.runId,
      expect.objectContaining({
        eventType: 'hook_created',
        correlationId: 'hook_awaited',
      }),
      expect.anything()
    );
    expect(result.hasAwaitedHookCreation).toBe(true);
    expect(result.timeoutSeconds).toBeUndefined();
  });

  it('still returns owned pending steps when an awaited hook is created with a step', async () => {
    const eventsCreate = vi.fn().mockResolvedValue({
      event: {
        eventType: 'hook_created',
      },
    });
    const world = createWorld(eventsCreate);
    const pending = new Map([
      [
        'step_parallel',
        {
          type: 'step' as const,
          correlationId: 'step_parallel',
          stepName: 'parallelStep',
          args: [],
        },
      ],
      [
        'hook_awaited',
        {
          type: 'hook' as const,
          correlationId: 'hook_awaited',
          token: 'claim-token',
          hasConflictAwaiter: true,
        },
      ],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    expect(result.hasAwaitedHookCreation).toBe(true);
    expect(result.timeoutSeconds).toBeUndefined();
    expect(result.pendingSteps).toHaveLength(1);
    expect(result.createdStepCorrelationIds).toContain('step_parallel');
  });

  it('does not immediately continue after creating a hook without a getConflict awaiter', async () => {
    const eventsCreate = vi.fn().mockResolvedValue({
      event: {
        eventType: 'hook_created',
      },
    });
    const world = createWorld(eventsCreate);
    const pending = new Map([
      [
        'hook_payload',
        {
          type: 'hook' as const,
          correlationId: 'hook_payload',
          token: 'payload-token',
        },
      ],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    expect(result.hasAwaitedHookCreation).toBe(false);
    expect(result.timeoutSeconds).toBeUndefined();
  });

  describe('force-claim victim wake', () => {
    const claimedFrom = {
      runId: 'wrun_victim',
      hookId: 'hook_victim',
      workflowName: 'victim-workflow',
      deploymentId: 'dpl_victim',
      runSpecVersion: SPEC_VERSION_CURRENT,
    };
    const forcedCreation = (
      slot: number,
      {
        createdAt = new Date(),
        hookId = 'hook_claimer',
        from = claimedFrom,
      }: {
        createdAt?: Date;
        hookId?: string;
        from?: Record<string, unknown>;
      } = {}
    ): Event =>
      ({
        eventType: 'hook_created',
        eventId: slotToEventId(slot),
        runId: run.runId,
        correlationId: hookId,
        createdAt,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          token: `channel:${hookId}`,
          force: true,
          forceClaimedFrom: from,
        },
      }) as Event;
    const ownRow = (
      slot: number,
      eventType: Event['eventType'],
      correlationId: string,
      eventData: unknown = {}
    ): Event =>
      ({
        eventType,
        eventId: slotToEventId(slot),
        runId: run.runId,
        correlationId,
        createdAt: new Date(),
        specVersion: SPEC_VERSION_CURRENT,
        eventData,
      }) as Event;
    const worldWithQueue = (
      queue: ReturnType<typeof vi.fn>,
      eventsCreate: ReturnType<typeof vi.fn> = vi.fn()
    ): World =>
      ({
        events: { create: eventsCreate },
        getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
        queue,
      }) as unknown as World;
    const suspendOver = (
      queue: ReturnType<typeof vi.fn>,
      events: Event[],
      extra: { forceClaimVictimWakes?: Set<string> } = {}
    ) =>
      handleSuspension({
        suspension: new WorkflowSuspension(new Map(), globalThis),
        world: worldWithQueue(queue),
        run,
        eventLog: { events, cursor: null },
        ...extra,
      });

    it("republishes past a delivery's hook_received", async () => {
      // The trace TLC found for the tail rule: the claimer dies after
      // journaling and a delivery lands before it comes back. The window rule
      // never looks past the creation, so it is unaffected.
      const queue = vi.fn().mockResolvedValue({ messageId: 'msg_wake' });
      await suspendOver(queue, [
        forcedCreation(3),
        ownRow(4, 'hook_received', 'hook_claimer', {
          token: 'channel:1',
          payload: { n: 1 },
        }),
      ]);
      expect(queue).toHaveBeenCalledTimes(1);
    });

    it("repays the victim's wake when a later claimer took the token from this run (the chain)", async () => {
      // This run took the token from the victim, died before waking it, and a
      // third run then took the token from THIS run, appending
      // `hook_disposed{forceClaimedBy}` here and waking it. That wake is the
      // invocation that must repay the victim's.
      const queue = vi.fn().mockResolvedValue({ messageId: 'msg_wake' });
      await suspendOver(queue, [
        forcedCreation(3),
        ownRow(4, 'hook_disposed', 'hook_claimer', {
          forceClaimedBy: { runId: 'wrun_third', hookId: 'hook_third' },
        }),
        ownRow(5, 'step_completed', 'step_after', { result: [] }),
      ]);
      expect(queue).toHaveBeenCalledTimes(1);
      expect(queue.mock.calls[0][1]).toEqual({ runId: 'wrun_victim' });
    });

    it("still republishes after the run's own hook_disposed", async () => {
      // Disposing the hook says nothing about whether its victim was woken.
      const queue = vi.fn().mockResolvedValue({ messageId: 'msg_wake' });
      await suspendOver(queue, [
        forcedCreation(3),
        ownRow(4, 'hook_disposed', 'hook_claimer'),
      ]);
      expect(queue).toHaveBeenCalledTimes(1);
    });

    it('stops republishing once the forced creation is outside the window', async () => {
      const queue = vi.fn().mockResolvedValue({ messageId: 'msg_wake' });
      await suspendOver(queue, [
        forcedCreation(3, {
          createdAt: new Date(
            Date.now() - FORCE_CLAIM_WAKE_REPUBLISH_WINDOW_MS - 1_000
          ),
        }),
      ]);
      expect(queue).not.toHaveBeenCalled();
    });

    it('skips a self-claim and a victim with no recorded workflowName', async () => {
      const queue = vi.fn().mockResolvedValue({ messageId: 'msg_wake' });
      await suspendOver(queue, [
        forcedCreation(3, {
          hookId: 'hook_self',
          from: { ...claimedFrom, runId: run.runId },
        }),
        forcedCreation(4, {
          hookId: 'hook_legacy',
          from: { runId: 'wrun_legacy', hookId: 'hook_legacy_victim' },
        }),
      ]);
      expect(queue).not.toHaveBeenCalled();
    });

    it('sends each hook once per invocation across its suspensions', async () => {
      // The caller passes one set for the whole invocation, so a run that
      // suspends more than once does not resend the wake on every pass.
      const queue = vi.fn().mockResolvedValue({ messageId: 'msg_wake' });
      const forceClaimVictimWakes = new Set<string>();
      const events = [forcedCreation(3)];
      await suspendOver(queue, events, { forceClaimVictimWakes });
      await suspendOver(queue, events, { forceClaimVictimWakes });
      expect(queue).toHaveBeenCalledTimes(1);
      expect([...forceClaimVictimWakes]).toEqual(['hook_claimer']);
    });

    it('does not resend the wake of a forced creation this invocation made itself', async () => {
      const queue = vi.fn().mockResolvedValue({ messageId: 'msg_wake' });
      const eventsCreate = vi.fn(async (_runId, event) => ({
        event: {
          ...event,
          eventId: slotToEventId(3),
          createdAt: new Date(),
        },
        hook: { hookId: 'hook_claimer', claimedFrom },
      }));
      const forceClaimVictimWakes = new Set<string>();
      const eventLog = { events: [] as Event[], cursor: null };
      await handleSuspension({
        suspension: new WorkflowSuspension(
          new Map<string, QueueItem>([
            [
              'hook_claimer',
              {
                type: 'hook',
                correlationId: 'hook_claimer',
                token: 'channel:1',
                force: true,
              },
            ],
          ]),
          globalThis
        ),
        world: worldWithQueue(queue, eventsCreate),
        run,
        eventLog,
        forceClaimVictimWakes,
      });
      // The next pass of the same invocation replays over the creation.
      await handleSuspension({
        suspension: new WorkflowSuspension(new Map(), globalThis),
        world: worldWithQueue(queue, eventsCreate),
        run,
        eventLog: { events: [forcedCreation(3)], cursor: null },
        forceClaimVictimWakes,
      });
      expect(queue).toHaveBeenCalledTimes(1);
    });

    it("does not hold the suspension's writes for the republish", async () => {
      // The rule reads nothing the suspension writes, so the republish rides
      // alongside the writes; the queue here only answers once a write has
      // been issued, which a republish-first order would never let happen.
      let releaseQueue!: () => void;
      const queueHeld = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      const order: string[] = [];
      const queue = vi.fn(async () => {
        await queueHeld;
        order.push('wake');
        return { messageId: 'msg_wake' };
      });
      const eventsCreate = vi.fn(async (_runId, event) => {
        order.push(event.eventType);
        releaseQueue();
        return { event };
      });
      await handleSuspension({
        suspension: new WorkflowSuspension(
          new Map<string, QueueItem>([
            [
              'w1',
              {
                type: 'wait',
                correlationId: 'w1',
                resumeAt: new Date(Date.now() + 60_000),
              },
            ],
          ]),
          globalThis
        ),
        world: worldWithQueue(queue, eventsCreate),
        run,
        eventLog: { events: [forcedCreation(3)], cursor: null },
      });
      expect(order).toEqual(['wait_created', 'wake']);
    });
  });

  describe('hook writes alongside the rest of the suspension', () => {
    // With an inline cap of 1 the first uncreated step defers to the caller's
    // lazy claim and writes nothing here, so every test pairs it with an
    // eager one.
    beforeEach(() => {
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const step = (id: string) =>
      [
        id,
        { type: 'step' as const, correlationId: id, stepName: id, args: [] },
      ] as const;
    const hook = (id: string, extra: Record<string, unknown> = {}) =>
      [
        id,
        {
          type: 'hook' as const,
          correlationId: id,
          token: `tok-${id}`,
          ...extra,
        },
      ] as const;

    it('creates a hook before delivering its abort within one suspension', async () => {
      const order: string[] = [];
      const eventsCreate = vi.fn(async (_runId, event) => {
        order.push(`${event.eventType}:${event.correlationId}`);
        return { event };
      });
      const world = {
        events: { create: eventsCreate },
        getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
        streams: {
          write: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as World;

      await handleSuspension({
        suspension: new WorkflowSuspension(
          new Map<string, QueueItem>([
            hook('hook_abort', { isSystem: true, abortRequested: true }),
          ]),
          globalThis
        ),
        world,
        run,
      });

      expect(order).toEqual([
        'hook_created:hook_abort',
        'hook_received:hook_abort',
      ]);
    });

    it('merges the hook delta in slot order around a concurrent skipped-slot report', async () => {
      // The step write lands at slot 4 and reports slot 3 (another writer's
      // event), which is folded in before the hook create, at slot 2, hands
      // back its delta. Appending that delta would put slot 2 after slot 3.
      const slotEvent = (slot: number, eventType: Event['eventType']) =>
        ({
          eventId: slotToEventId(slot),
          eventType,
          runId: run.runId,
          createdAt: new Date(),
        }) as Event;
      const eventLog = {
        events: [slotEvent(1, 'run_started')],
        cursor: 'eid:cursor_1',
      };
      let releaseHook!: () => void;
      const hookHeld = new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      const eventsCreate = vi.fn(async (_runId, event) => {
        if (event.eventType === 'hook_created') {
          await hookHeld;
          const committed = { ...event, eventId: slotToEventId(2) } as Event;
          return {
            event: committed,
            events: [committed],
            cursor: `eid:${committed.eventId}`,
            hasMore: false,
          };
        }
        // The hook create returns only once this write's report is in.
        setTimeout(releaseHook, 0);
        return {
          event: { ...event, eventId: slotToEventId(4) },
          events: [slotEvent(3, 'hook_received')],
        };
      });

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          new Map<string, QueueItem>([
            hook('hook_1'),
            step('s_lazy'),
            step('s_eager'),
          ]),
          globalThis
        ),
        world: createWorld(eventsCreate),
        run,
        eventLog,
      });

      expect(eventLog.events.map((e) => e.eventId)).toEqual([
        slotToEventId(1),
        slotToEventId(2),
        slotToEventId(3),
      ]);
      expect(eventLog.cursor).toBe(`eid:${slotToEventId(2)}`);
      // Two writes, so the log is not claimed complete.
      expect(result.eventLogCarriedForward).toBe(false);
    });

    it('counts only the stretch a hook create outlasts the other writes', async () => {
      // Fake timers: with real ones, one event-loop stall longer than the hook
      // delay fires both timers in the same tick and the measured stretch
      // collapses to 0 on a loaded CI runner.
      vi.useFakeTimers();
      try {
        const delay = (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms));
        const suspend = async (hookMs: number, stepMs: number) => {
          const eventsCreate = vi.fn(async (_runId, event) => {
            await delay(event.eventType === 'hook_created' ? hookMs : stepMs);
            return { event };
          });
          const result = handleSuspension({
            suspension: new WorkflowSuspension(
              new Map<string, QueueItem>([
                hook('hook_1'),
                step('s_lazy'),
                step('s_eager'),
              ]),
              globalThis
            ),
            world: createWorld(eventsCreate),
            run,
          });
          let settled = false;
          void result.finally(() => {
            settled = true;
          });
          while (!settled) await vi.advanceTimersByTimeAsync(1);
          return result;
        };

        // The step write outlasts the hook create: the hook never blocked.
        expect((await suspend(5, 120)).hookCreationMs).toBe(0);
        // The hook create outlasts the step write by exactly the difference.
        expect((await suspend(120, 5)).hookCreationMs).toBe(115);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Regression test for #2777: a dispose() of an earlier hook must be
  // flushed before a later same-token hook's creation is validated, or the
  // new hook records a spurious hook_conflict against the run's own
  // disposed hook.
  it('flushes a prior hook disposal before validating a same-token recreation', async () => {
    const eventsCreate = vi.fn(async (_runId, event) => ({ event }));
    const world = createWorld(eventsCreate);
    const pending = new Map([
      [
        'hook_old',
        {
          type: 'hook' as const,
          correlationId: 'hook_old',
          token: 'reused-token',
          hasCreatedEvent: true,
          disposed: true,
        },
      ],
      [
        'hook_new',
        {
          type: 'hook' as const,
          correlationId: 'hook_new',
          token: 'reused-token',
          hasConflictAwaiter: true,
        },
      ],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    const hookCalls = eventsCreate.mock.calls.map(([, event]) => ({
      eventType: event.eventType,
      correlationId: event.correlationId,
    }));
    expect(hookCalls).toEqual([
      { eventType: 'hook_disposed', correlationId: 'hook_old' },
      { eventType: 'hook_created', correlationId: 'hook_new' },
    ]);
    expect(result.hasHookConflict).toBe(false);
    expect(result.hasAwaitedHookCreation).toBe(true);
  });

  it('creates a hook before disposing it when both happen within one suspension', async () => {
    const eventsCreate = vi.fn(async (_runId, event) => ({ event }));
    const world = createWorld(eventsCreate);
    const pending = new Map([
      [
        'hook_ephemeral',
        {
          type: 'hook' as const,
          correlationId: 'hook_ephemeral',
          token: 'ephemeral-token',
          disposed: true,
        },
      ],
    ]);

    await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    const hookCalls = eventsCreate.mock.calls.map(([, event]) => ({
      eventType: event.eventType,
      correlationId: event.correlationId,
    }));
    expect(hookCalls).toEqual([
      { eventType: 'hook_created', correlationId: 'hook_ephemeral' },
      { eventType: 'hook_disposed', correlationId: 'hook_ephemeral' },
    ]);
  });

  it('does not dispose a hook whose creation conflicted', async () => {
    const eventsCreate = vi.fn(async (_runId, event) => {
      if (event.eventType === 'hook_created') {
        return { event: { eventType: 'hook_conflict' } };
      }
      return { event };
    });
    const world = createWorld(eventsCreate);
    const pending = new Map([
      [
        'hook_contended',
        {
          type: 'hook' as const,
          correlationId: 'hook_contended',
          token: 'contended-token',
          disposed: true,
        },
      ],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    expect(result.hasHookConflict).toBe(true);
    expect(
      eventsCreate.mock.calls.some(
        ([, event]) => event.eventType === 'hook_disposed'
      )
    ).toBe(false);
  });

  // A stale-snapshot rejection sends the caller into a replay restart. Any
  // sibling create still in flight at that moment would commit an event minted
  // from the abandoned replay's correlation-id sequence, and would race the
  // restart's reload of the log — so the phase has to settle first.
  it('settles every write in a phase before a stale-snapshot rejection escapes', async () => {
    let slowCreateSettled = false;
    let rejectedAt: boolean | undefined;
    const eventsCreate = vi.fn(async (_runId, event) => {
      if (event.correlationId === 'wait_fenced') {
        throw new PreconditionFailedError('Run state is stale');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      slowCreateSettled = true;
      return { event };
    });
    const world = createWorld(eventsCreate);
    const resumeAt = new Date(Date.now() + 60_000);
    const pending = new Map([
      [
        'wait_fenced',
        { type: 'wait' as const, correlationId: 'wait_fenced', resumeAt },
      ],
      [
        'wait_slow',
        { type: 'wait' as const, correlationId: 'wait_slow', resumeAt },
      ],
    ]);

    await expect(
      handleSuspension({
        suspension: new WorkflowSuspension(pending, globalThis),
        world,
        run,
      }).catch((err) => {
        rejectedAt = slowCreateSettled;
        throw err;
      })
    ).rejects.toBeInstanceOf(PreconditionFailedError);

    expect(rejectedAt).toBe(true);
  });

  // The 412 wins over the sibling failure because it has a defined, cheap
  // recovery (replay from a corrected log). A deterministic sibling failure
  // recurs on the restart and fails the run then.
  it('prefers the stale-snapshot rejection over a sibling failure in the same phase', async () => {
    const eventsCreate = vi.fn(async (_runId, event) => {
      if (event.correlationId === 'wait_broken') {
        throw new Error('some other world failure');
      }
      throw new PreconditionFailedError('Run state is stale');
    });
    const world = createWorld(eventsCreate);
    const resumeAt = new Date(Date.now() + 60_000);
    const pending = new Map([
      [
        'wait_broken',
        { type: 'wait' as const, correlationId: 'wait_broken', resumeAt },
      ],
      [
        'wait_fenced',
        { type: 'wait' as const, correlationId: 'wait_fenced', resumeAt },
      ],
    ]);

    await expect(
      handleSuspension({
        suspension: new WorkflowSuspension(pending, globalThis),
        world,
        run,
      })
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  describe('skipped-slot reports', () => {
    /** A slot-numbered log event, minimal beyond what a snapshot reads. */
    function slotEvent(slot: number, eventType: Event['eventType']): Event {
      return {
        eventId: slotToEventId(slot),
        eventType,
        runId: run.runId,
        createdAt: new Date(),
      } as Event;
    }

    /** One wait, so exactly one guarded write carries the report back. */
    function oneWait() {
      return new Map([
        [
          'wait_reported',
          {
            type: 'wait' as const,
            correlationId: 'wait_reported',
            resumeAt: new Date(Date.now() + 60_000),
          },
        ],
      ]);
    }

    it('merges a complete report into the caller event log', async () => {
      const eventLog = { events: [slotEvent(1, 'run_started')], cursor: null };
      const skipped = slotEvent(2, 'hook_received');
      const eventsCreate = vi.fn(async (_runId, event) => ({
        event: { ...event, eventId: slotToEventId(3) },
        events: [skipped],
      }));

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(oneWait(), globalThis),
        world: createWorld(eventsCreate),
        run,
        eventLog,
      });

      expect(result.reportedEventCount).toBe(1);
      // The replay that resumes from this log sees the skipped event without
      // reloading, and the log still says how far it reaches.
      expect(eventLog.events.map((e) => e.eventId)).toEqual([
        slotToEventId(1),
        slotToEventId(2),
      ]);
      expect(maxEventSlot(eventLog.events)).toBe(2);
    });

    it('drops a truncated report instead of raising the log past a hole', async () => {
      const eventLog = { events: [slotEvent(1, 'run_started')], cursor: null };
      // Slot 2 is on the same skipped span but absent from the report, so
      // merging slot 3 would put the log's maximum above a missing position.
      // Later writes read that maximum to say what they have seen, and a World
      // only reports the span a write skips, so slot 2 would never be sent.
      const skipped = slotEvent(3, 'hook_received');
      const eventsCreate = vi.fn(async (_runId, event) => ({
        event: { ...event, eventId: slotToEventId(4) },
        events: [skipped],
        hasMore: true,
      }));

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(oneWait(), globalThis),
        world: createWorld(eventsCreate),
        run,
        eventLog,
      });

      expect(result.reportedEventCount).toBe(0);
      expect(eventLog.events.map((e) => e.eventId)).toEqual([slotToEventId(1)]);
      expect(maxEventSlot(eventLog.events)).toBe(1);
    });
  });

  // The hook create asks the World for the event-log delta since the caller's
  // cursor, so a caller holding the hook's awaiter can settle it off the
  // response instead of re-invoking to read the event back — on whichever
  // event the create commits.
  describe('hook creation inline delta', () => {
    function slotEvent(slot: number, eventType: Event['eventType']): Event {
      return {
        eventId: slotToEventId(slot),
        eventType,
        runId: run.runId,
        createdAt: new Date(),
      } as Event;
    }

    function awaitedHook(correlationId = 'hook_awaited') {
      return [
        correlationId,
        {
          type: 'hook' as const,
          correlationId,
          token: `tok-${correlationId}`,
          hasConflictAwaiter: true,
        },
      ] as const;
    }

    /**
     * A World that answers `sinceCursor` with the write it just committed.
     *
     * `conflict` commits `hook_conflict` in place of a `hook_created`, the way
     * a World does when another run already holds the token: same slot, same
     * delta, a different event on it.
     */
    function deltaWorld(startSlot = 2, { conflict = false } = {}) {
      let slot = startSlot;
      return vi.fn(async (_runId, event, params) => {
        const substituted =
          conflict && event.eventType === 'hook_created'
            ? {
                ...event,
                eventType: 'hook_conflict',
                eventData: {
                  token: event.eventData?.token,
                  conflictingRunId: 'wrun_token_owner',
                },
              }
            : event;
        const committed = {
          ...substituted,
          eventId: slotToEventId(slot++),
        } as Event;
        if (typeof params?.sinceCursor !== 'string') {
          return { event: committed };
        }
        return {
          event: committed,
          events: [committed],
          cursor: `eid:${committed.eventId}`,
          hasMore: false,
        };
      });
    }

    it('folds the created hook event into the caller log and says so', async () => {
      const eventLog = {
        events: [slotEvent(1, 'run_started')],
        cursor: 'eid:cursor_1',
      };
      const eventsCreate = deltaWorld();

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          new Map([awaitedHook()]),
          globalThis
        ),
        world: createWorld(eventsCreate),
        run,
        eventLog,
      });

      expect(eventsCreate).toHaveBeenCalledWith(
        run.runId,
        expect.objectContaining({ eventType: 'hook_created' }),
        expect.objectContaining({ sinceCursor: 'eid:cursor_1' })
      );
      // The log now holds the event that resolves the awaiter, and its read
      // position moved with it — so a caller can replay/resume off it with no
      // read of its own.
      expect(eventLog.events.map((e) => e.eventType)).toEqual([
        'run_started',
        'hook_created',
      ]);
      expect(eventLog.cursor).toBe(`eid:${slotToEventId(2)}`);
      expect(result.eventLogCarriedForward).toBe(true);
      expect(result.awaitedHookCorrelationIds).toEqual(['hook_awaited']);
      expect(result.hookConflictCorrelationIds).toEqual([]);
      // A delta is not a skipped-slot report: it extends the tail, so the
      // caller's cached scan positions stay valid.
      expect(result.reportedEventCount).toBe(0);
    });

    it('folds a committed hook_conflict into the caller log and says so', async () => {
      // The conflict outcome of the same write. It is the event the hook's
      // awaiters settle on, so it carries the log forward exactly as a
      // `hook_created` does — and is reported by hook id, so a caller
      // continuing in-process can tell a fresh pass from a repeating one.
      const eventLog = {
        events: [slotEvent(1, 'run_started')],
        cursor: 'eid:cursor_1',
      };
      const eventsCreate = deltaWorld(2, { conflict: true });

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          new Map([awaitedHook('hook_taken')]),
          globalThis
        ),
        world: createWorld(eventsCreate),
        run,
        eventLog,
      });

      // Asked for on the way in, before the outcome was known — the request is
      // still a `hook_created`.
      expect(eventsCreate).toHaveBeenCalledWith(
        run.runId,
        expect.objectContaining({ eventType: 'hook_created' }),
        expect.objectContaining({ sinceCursor: 'eid:cursor_1' })
      );
      expect(eventLog.events.map((e) => e.eventType)).toEqual([
        'run_started',
        'hook_conflict',
      ]);
      expect(eventLog.cursor).toBe(`eid:${slotToEventId(2)}`);
      expect(result.eventLogCarriedForward).toBe(true);
      expect(result.hasHookConflict).toBe(true);
      expect(result.hookConflictCorrelationIds).toEqual(['hook_taken']);
      // A conflict means the hook was never created, so its `getConflict()`
      // awaiter is settled by the conflict rather than by a creation — the
      // caller takes the conflict branch, not the awaited-creation one.
      expect(result.hasAwaitedHookCreation).toBe(false);
      expect(result.awaitedHookCorrelationIds).toEqual([]);
    });

    it('does not carry the log forward on a conflict when a wait also wrote', async () => {
      // Same accounting as the creation case: the `wait_created` lands above
      // the delta the hook write returned, so the caller has to read before
      // continuing over the conflict. Also pins that a conflict suppresses the
      // wait timeout — the caller advances the workflow over the conflict
      // before scheduling anything, and the pass after it reports the wait.
      const eventLog = {
        events: [slotEvent(1, 'run_started')],
        cursor: 'eid:cursor_1',
      };

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          new Map([
            awaitedHook('hook_taken'),
            [
              'w1',
              {
                type: 'wait' as const,
                correlationId: 'w1',
                resumeAt: new Date(Date.now() + 30_000),
              },
            ],
          ]),
          globalThis
        ),
        world: createWorld(deltaWorld(2, { conflict: true })),
        run,
        eventLog,
      });

      expect(result.hookConflictCorrelationIds).toEqual(['hook_taken']);
      expect(result.eventLogCarriedForward).toBe(false);
      expect(result.waitTimeout).toBeUndefined();
    });

    it('leaves the log alone on a conflict when the World returns no delta', async () => {
      const eventLog = {
        events: [slotEvent(1, 'run_started')],
        cursor: 'eid:cursor_1',
      };
      const eventsCreate = vi.fn(async (_runId, event) => ({
        event: {
          ...event,
          eventType: 'hook_conflict',
          eventId: slotToEventId(2),
        },
      }));

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          new Map([awaitedHook('hook_taken')]),
          globalThis
        ),
        world: createWorld(eventsCreate),
        run,
        eventLog,
      });

      expect(eventLog.events.map((e) => e.eventType)).toEqual(['run_started']);
      expect(eventLog.cursor).toBe('eid:cursor_1');
      expect(result.eventLogCarriedForward).toBe(false);
      expect(result.hookConflictCorrelationIds).toEqual(['hook_taken']);
    });

    it('asks for no delta when the suspension creates two hooks', async () => {
      // Both creates would diff against the same cursor and only one delta
      // could be folded in, so the log would end up short of the other's event
      // with nothing to say so.
      const eventLog = {
        events: [slotEvent(1, 'run_started')],
        cursor: 'eid:cursor_1',
      };
      const eventsCreate = deltaWorld();

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          new Map([awaitedHook('hook_a'), awaitedHook('hook_b')]),
          globalThis
        ),
        world: createWorld(eventsCreate),
        run,
        eventLog,
      });

      for (const call of eventsCreate.mock.calls) {
        expect(call[2]?.sinceCursor).toBeUndefined();
      }
      expect(result.eventLogCarriedForward).toBe(false);
      expect([...result.awaitedHookCorrelationIds].sort()).toEqual([
        'hook_a',
        'hook_b',
      ]);
    });

    it('declines a truncated delta rather than moving the cursor past it', async () => {
      const eventLog = {
        events: [slotEvent(1, 'run_started')],
        cursor: 'eid:cursor_1',
      };
      const eventsCreate = vi.fn(async (_runId, event) => ({
        event: { ...event, eventId: slotToEventId(2) },
        events: [slotEvent(2, 'hook_created')],
        cursor: 'eid:cursor_2',
        hasMore: true,
      }));

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          new Map([awaitedHook()]),
          globalThis
        ),
        world: createWorld(eventsCreate),
        run,
        eventLog,
      });

      expect(eventLog.events.map((e) => e.eventType)).toEqual(['run_started']);
      expect(eventLog.cursor).toBe('eid:cursor_1');
      expect(result.eventLogCarriedForward).toBe(false);
    });

    it('leaves the log alone when the World returns no delta', async () => {
      // Any World may ignore `sinceCursor`; the caller then reads instead.
      const eventLog = {
        events: [slotEvent(1, 'run_started')],
        cursor: 'eid:cursor_1',
      };
      const eventsCreate = vi.fn(async (_runId, event) => ({
        event: { ...event, eventId: slotToEventId(2) },
      }));

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          new Map([awaitedHook()]),
          globalThis
        ),
        world: createWorld(eventsCreate),
        run,
        eventLog,
      });

      expect(eventLog.events.map((e) => e.eventType)).toEqual(['run_started']);
      expect(eventLog.cursor).toBe('eid:cursor_1');
      expect(result.eventLogCarriedForward).toBe(false);
      expect(result.hasAwaitedHookCreation).toBe(true);
    });

    it('asks for no delta on a log with no cursor (turbo)', async () => {
      const eventLog = { events: [], cursor: null };
      const eventsCreate = deltaWorld(1);

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          new Map([awaitedHook()]),
          globalThis
        ),
        world: createWorld(eventsCreate),
        run,
        eventLog,
      });

      expect(eventsCreate.mock.calls[0][2]?.sinceCursor).toBeUndefined();
      expect(result.eventLogCarriedForward).toBe(false);
    });
  });
});

describe('serializationBlockers', () => {
  /** An object with a VM-realm getter — exactly what the sink records. */
  function vmGetterObject() {
    return runInNewContext(
      `const o = {};
       Object.defineProperty(o, 'lazy', {
         enumerable: true,
         get: () => 'computed',
       });
       o`
    );
  }

  async function runSuspension(item: QueueItem) {
    const eventsCreate = vi
      .fn()
      .mockImplementation(async (_runId, event) => ({ event }));
    const world = createWorld(eventsCreate);
    return handleSuspension({
      suspension: new WorkflowSuspension(
        new Map([[item.correlationId, item]]),
        globalThis
      ),
      world,
      run,
    });
  }

  function runStep(args: Extract<QueueItem, { type: 'step' }>['args']) {
    return runSuspension({
      type: 'step',
      correlationId: 'step_1',
      stepName: 'someStep',
      args,
    });
  }

  it('reports no blockers for plain data and supported built-ins', async () => {
    const result = await runStep([
      { nested: [{ ok: true }, 'text', 42n], flag: false },
      new Map([['k', new Set([1])]]),
      new Date(1700000000000),
      new Uint8Array([1, 2, 3]),
      /pattern/gi,
      new URL('https://example.com/'),
    ]);
    expect(result.serializationBlockers).toEqual([]);
  });

  it('reports the blocker for an Error argument (stack materialization)', async () => {
    // Serializing an error reads `stack`, an own engine accessor whose first
    // invocation formats-and-caches the trace and runs any
    // `Error.prepareStackTrace` — neither is repeated by a cold replay, so
    // the boundary must demote.
    const result = await runStep([new Error('lazy stack')]);
    expect(result.serializationBlockers).toContainEqual({
      source: 'step_input',
      correlationId: 'step_1',
      kind: 'getter',
      detail: 'stack',
    });
  });

  it('reports every getter executed while serializing step input', async () => {
    const result = await runStep([
      { deep: [vmGetterObject(), vmGetterObject()] },
    ]);
    expect(result.serializationBlockers).toEqual([
      {
        source: 'step_input',
        correlationId: 'step_1',
        kind: 'getter',
        detail: 'lazy',
      },
      {
        source: 'step_input',
        correlationId: 'step_1',
        kind: 'getter',
        detail: 'lazy',
      },
    ]);
  });

  it('reports a proxy encountered in step input', async () => {
    const result = await runStep([new Proxy({ a: 1 }, {})]);
    expect(result.serializationBlockers).toContainEqual({
      source: 'step_input',
      correlationId: 'step_1',
      kind: 'proxy',
    });
  });

  it.each([
    [
      'hook metadata',
      {
        type: 'hook',
        correlationId: 'hook_unsafe_metadata',
        token: 'unsafe-metadata',
        metadata: vmGetterObject(),
      },
    ],
    [
      'a hook abort reason',
      {
        type: 'hook',
        correlationId: 'hook_unsafe_abort',
        token: 'unsafe-abort',
        hasCreatedEvent: true,
        abortRequested: true,
        abortReason: vmGetterObject(),
      },
    ],
  ] satisfies [
    string,
    QueueItem,
  ][])('reports the serialization source for %s', async (_, item) => {
    const result = await runSuspension(item);
    expect(result.serializationBlockers).toContainEqual(
      expect.objectContaining({
        source:
          item.correlationId === 'hook_unsafe_metadata'
            ? 'hook_metadata'
            : 'hook_abort',
        correlationId: item.correlationId,
        kind: 'getter',
        detail: 'lazy',
      })
    );
  });
});
