import { runInNewContext } from 'node:vm';
import {
  FatalError,
  PreconditionFailedError,
  WorkflowWorldError,
} from '@workflow/errors';
import type { Event, WorkflowRun, World } from '@workflow/world';
import { slotToEventId } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowSuspension } from '../global.js';
import { maxEventSlot } from './helpers.js';
import { ReplayRecoveryReporter } from './replay-recovery-reporter.js';
import { handleSuspension } from './suspension-handler.js';

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

  it('defers up to getMaxInlineSteps() uncreated steps and eagerly creates the rest', async () => {
    // Default getMaxInlineSteps() is 3. With 4 uncreated parallel steps, the
    // first 3 are deferred for lazy inline start (no step_created written) and
    // the 4th keeps its eager step_created and is owned for queuing.
    const eventsCreate = vi.fn().mockResolvedValue({
      event: { eventType: 'step_created' },
    });
    const world = createWorld(eventsCreate);
    const pending = new Map(
      ['s1', 's2', 's3', 's4'].map((id) => [
        id,
        { type: 'step' as const, correlationId: id, stepName: id, args: [] },
      ])
    );

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    expect(result.lazyInlineSteps.map((s) => s.correlationId)).toEqual([
      's1',
      's2',
      's3',
    ]);
    // Only the non-deferred step writes a step_created and is owned.
    expect(eventsCreate).toHaveBeenCalledTimes(1);
    expect(eventsCreate).toHaveBeenCalledWith(
      run.runId,
      expect.objectContaining({
        eventType: 'step_created',
        correlationId: 's4',
      }),
      expect.anything()
    );
    expect([...result.createdStepCorrelationIds]).toEqual(['s4']);
  });

  it('honors WORKFLOW_MAX_INLINE_STEPS as the inline cap', async () => {
    const prev = process.env.WORKFLOW_MAX_INLINE_STEPS;
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    try {
      const eventsCreate = vi.fn().mockResolvedValue({
        event: { eventType: 'step_created' },
      });
      const world = createWorld(eventsCreate);
      const pending = new Map(
        ['s1', 's2', 's3'].map((id) => [
          id,
          { type: 'step' as const, correlationId: id, stepName: id, args: [] },
        ])
      );

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(pending, globalThis),
        world,
        run,
      });

      // Cap of 1: only the first step is deferred; s2 and s3 are eager-created.
      expect(result.lazyInlineSteps.map((s) => s.correlationId)).toEqual([
        's1',
      ]);
      expect(eventsCreate).toHaveBeenCalledTimes(2);
      expect([...result.createdStepCorrelationIds].sort()).toEqual([
        's2',
        's3',
      ]);
    } finally {
      if (prev === undefined) delete process.env.WORKFLOW_MAX_INLINE_STEPS;
      else process.env.WORKFLOW_MAX_INLINE_STEPS = prev;
    }
  });

  it('defers no inline steps when a hook.getConflict() awaiter is present', async () => {
    const eventsCreate = vi.fn().mockResolvedValue({
      event: { eventType: 'hook_created' },
    });
    const world = createWorld(eventsCreate);
    const pending = new Map([
      [
        's1',
        {
          type: 'step' as const,
          correlationId: 's1',
          stepName: 's1',
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

    // Nothing runs inline: the step keeps its eager step_created (owned) and is
    // queued; the caller re-invokes immediately to resolve the awaiter.
    expect(result.lazyInlineSteps).toEqual([]);
    expect(result.createdStepCorrelationIds).toContain('s1');
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
});

describe('retainedStepInputsSafe (serialization passivity gate)', () => {
  function stepPending(args: unknown[]) {
    return new Map([
      [
        'step_1',
        {
          type: 'step' as const,
          correlationId: 'step_1',
          stepName: 'someStep',
          args,
        },
      ],
    ]);
  }

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

  async function runSuspension(args: unknown[]) {
    const eventsCreate = vi
      .fn()
      .mockImplementation(async (_runId, event) => ({ event }));
    const world = createWorld(eventsCreate);
    return handleSuspension({
      suspension: new WorkflowSuspension(stepPending(args), globalThis),
      world,
      run,
    });
  }

  it('reports safe for plain data and supported built-ins', async () => {
    const result = await runSuspension([
      { nested: [{ ok: true }, 'text', 42n], flag: false },
      new Map([['k', new Set([1])]]),
      new Date(1700000000000),
      new Uint8Array([1, 2, 3]),
      /pattern/gi,
      new URL('https://example.com/'),
    ]);
    expect(result.retainedStepInputsSafe).toBe(true);
  });

  it('reports unsafe for an Error argument (stack materialization)', async () => {
    // Serializing an error reads `stack`, an own engine accessor whose first
    // invocation formats-and-caches the trace and runs any
    // `Error.prepareStackTrace` — neither is repeated by a cold replay, so
    // the boundary must demote.
    const result = await runSuspension([new Error('lazy stack')]);
    expect(result.retainedStepInputsSafe).toBe(false);
  });

  it('reports unsafe when serializing an argument executes a getter', async () => {
    const value = vmGetterObject();
    const result = await runSuspension([{ deep: [value] }]);
    expect(result.retainedStepInputsSafe).toBe(false);
  });

  it('reports unsafe when an argument is a proxy', async () => {
    const result = await runSuspension([new Proxy({ a: 1 }, {})]);
    expect(result.retainedStepInputsSafe).toBe(false);
  });

  it('still serializes recorded inputs successfully (bytes are unaffected)', async () => {
    const value = vmGetterObject();
    const result = await runSuspension([value]);
    expect(result.retainedStepInputsSafe).toBe(false);
    // The step is still prepared for execution as usual (a single uncreated
    // step always lands in the lazy inline slice).
    expect(result.lazyInlineSteps).toHaveLength(1);
  });
});
