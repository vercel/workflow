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

describe('resilient step dispatch', () => {
  const queueName = '__wkf_workflow_test-workflow' as ValidQueueName;

  // Opt-in feature, so every test that expects a publish has to ask for it.
  // The default-off case is covered by its own test below, which unsets this.
  let previousFlag: string | undefined;
  beforeEach(() => {
    previousFlag = process.env.WORKFLOW_RESILIENT_STEP_DISPATCH;
    process.env.WORKFLOW_RESILIENT_STEP_DISPATCH = '1';
  });
  afterEach(() => {
    if (previousFlag === undefined) {
      delete process.env.WORKFLOW_RESILIENT_STEP_DISPATCH;
    } else {
      process.env.WORKFLOW_RESILIENT_STEP_DISPATCH = previousFlag;
    }
  });

  /** A run whose queue transport supports binary payloads (CBOR). */
  const cborRun: WorkflowRun = { ...run, specVersion: SPEC_VERSION_CURRENT };

  function createQueueWorld(overrides?: {
    eventsCreate?: ReturnType<typeof vi.fn>;
    queue?: ReturnType<typeof vi.fn>;
    capabilities?: World['capabilities'];
  }): {
    world: World;
    eventsCreate: ReturnType<typeof vi.fn>;
    queue: ReturnType<typeof vi.fn>;
  } {
    const eventsCreate =
      overrides?.eventsCreate ??
      vi.fn().mockImplementation(async (_runId, event) => ({ event }));
    const queue =
      overrides?.queue ?? vi.fn().mockResolvedValue({ messageId: 'msg_1' });
    const world = {
      events: { create: eventsCreate },
      queue,
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
      ...(overrides?.capabilities
        ? { capabilities: overrides.capabilities }
        : {}),
    } as unknown as World;
    return { world, eventsCreate, queue };
  }

  /** Four parallel steps: s1-s3 are lazy-inline (default cap 3), s4 overflows. */
  function fourStepsPending() {
    return new Map(
      ['s1', 's2', 's3', 's4'].map((id) => [
        id,
        { type: 'step' as const, correlationId: id, stepName: id, args: [] },
      ])
    );
  }

  const stepDispatch = () => ({
    queueName,
    getTraceCarrier: vi.fn().mockResolvedValue({ traceparent: '00-abc' }),
  });

  it('publishes the overflow step alongside its step_created, carrying stepInput', async () => {
    const { world, eventsCreate, queue } = createQueueWorld();

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(fourStepsPending(), globalThis),
      world,
      run: cborRun,
      stepDispatch: stepDispatch(),
    });

    // The overflow step is created AND queued by the suspension handler.
    expect(eventsCreate).toHaveBeenCalledWith(
      run.runId,
      expect.objectContaining({
        eventType: 'step_created',
        correlationId: 's4',
      }),
      expect.anything()
    );
    expect(queue).toHaveBeenCalledTimes(1);
    const [calledQueueName, payload, opts] = queue.mock.calls[0];
    expect(calledQueueName).toBe(queueName);
    expect(payload).toMatchObject({
      runId: run.runId,
      stepId: 's4',
      stepName: 's4',
      traceCarrier: { traceparent: '00-abc' },
    });
    // The message carries the same serialized input as the direct write.
    expect(payload.stepInput.input).toBeInstanceOf(Uint8Array);
    const createdInput = eventsCreate.mock.calls.find(
      ([, event]) => event.correlationId === 's4'
    )?.[1].eventData.input;
    expect(payload.stepInput.input).toBe(createdInput);
    // Step-identity-scoped key — matches the dispatch key runtime.ts uses for
    // the same step, so redundant publishes dedupe.
    expect(opts).toMatchObject({
      idempotencyKey: stepDispatchIdempotencyKey('s4', 's4'),
    });
    // Reported so the caller skips its own dispatch for this step.
    expect([...result.queuedStepCorrelationIds]).toEqual(['s4']);
    expect(result.createdStepCorrelationIds).toContain('s4');
  });

  it('swallows a transient step_created failure once the message is out (resilient)', async () => {
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => {
      if (event.eventType === 'step_created') {
        throw new WorkflowWorldError('backend blip', { status: 503 });
      }
      return { event };
    });
    const { world, queue } = createQueueWorld({ eventsCreate });

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(fourStepsPending(), globalThis),
      world,
      run: cborRun,
      stepDispatch: stepDispatch(),
    });

    // The publish carried the payload, so the consumer re-ensures the event.
    expect(queue).toHaveBeenCalledTimes(1);
    expect([...result.queuedStepCorrelationIds]).toEqual(['s4']);
    // The write did NOT land, so this handler does not claim creation.
    expect(result.createdStepCorrelationIds.has('s4')).toBe(false);
  });

  it('propagates a queue publish failure (the message is the durability bar)', async () => {
    const queue = vi.fn().mockRejectedValue(new Error('queue down'));
    const { world } = createQueueWorld({ queue });

    await expect(
      handleSuspension({
        suspension: new WorkflowSuspension(fourStepsPending(), globalThis),
        world,
        run: cborRun,
        stepDispatch: stepDispatch(),
      })
    ).rejects.toThrow('queue down');
  });

  it('propagates a non-retryable step_created failure even when the publish succeeded', async () => {
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => {
      if (event.eventType === 'step_created') {
        throw new WorkflowWorldError('bad request', { status: 400 });
      }
      return { event };
    });
    const { world } = createQueueWorld({ eventsCreate });

    await expect(
      handleSuspension({
        suspension: new WorkflowSuspension(fourStepsPending(), globalThis),
        world,
        run: cborRun,
        stepDispatch: stepDispatch(),
      })
    ).rejects.toThrow('bad request');
  });

  it('falls back to create-only when the run predates the CBOR queue transport', async () => {
    const { world, queue } = createQueueWorld();

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(fourStepsPending(), globalThis),
      world,
      run: { ...run, specVersion: 2 },
      stepDispatch: stepDispatch(),
    });

    expect(queue).not.toHaveBeenCalled();
    expect(result.queuedStepCorrelationIds.size).toBe(0);
  });

  it('falls back to create-only when WORKFLOW_RESILIENT_STEP_DISPATCH is unset', async () => {
    delete process.env.WORKFLOW_RESILIENT_STEP_DISPATCH;
    const { world, queue } = createQueueWorld();

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(fourStepsPending(), globalThis),
      world,
      run: cborRun,
      stepDispatch: stepDispatch(),
    });

    expect(queue).not.toHaveBeenCalled();
    expect(result.queuedStepCorrelationIds.size).toBe(0);
  });

  it('never queues from here when no stepDispatch is provided (terminal drain)', async () => {
    const { world, queue } = createQueueWorld();

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(fourStepsPending(), globalThis),
      world,
      run: cborRun,
    });

    expect(queue).not.toHaveBeenCalled();
    expect(result.queuedStepCorrelationIds.size).toBe(0);
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

  it('still serializes recorded inputs successfully (bytes are unaffected)', async () => {
    const value = vmGetterObject();
    const result = await runStep([value]);
    expect(result.serializationBlockers).not.toEqual([]);
    // The step is still prepared for execution as usual (a single uncreated
    // step always lands in the lazy inline slice).
    expect(result.lazyInlineSteps).toHaveLength(1);
  });
});

describe('handleSuspension batched fan-out', () => {
  const slotRun: WorkflowRun = { ...run, specVersion: 6 };

  function createBatchWorld(
    eventsCreate: ReturnType<typeof vi.fn>,
    createBatch?: ReturnType<typeof vi.fn>
  ): World {
    return {
      events: {
        create: eventsCreate,
        ...(createBatch ? { createBatch } : {}),
      },
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as World;
  }

  /** createBatch mock answering every event with a 200 at consecutive slots. */
  function successfulCreateBatch(firstSlot = 10) {
    let slot = firstSlot;
    return vi.fn().mockImplementation(async (_runId, events) => ({
      results: events.map(({ event }: { event: { eventType: string } }) => ({
        status: 200,
        event: { ...event, eventId: slotToEventId(slot++) },
      })),
    }));
  }

  function stepsAndWait(stepIds: string[], waitId?: string) {
    const pending = new Map<string, unknown>(
      stepIds.map((id) => [
        id,
        { type: 'step' as const, correlationId: id, stepName: id, args: [] },
      ])
    );
    if (waitId) {
      pending.set(waitId, {
        type: 'wait' as const,
        correlationId: waitId,
        resumeAt: new Date(Date.now() + 60_000),
      });
    }
    return pending as ConstructorParameters<typeof WorkflowSuspension>[0];
  }

  beforeEach(() => {
    // No WORKFLOW_BATCH_TRANSITIONS stub: the fold is DEFAULT ON, so these
    // tests exercising it with an unset env prove the default engages. The
    // kill switch has its own test below.
    // Cap lazy-inline deferral at 1 so only the first step defers its
    // step_created and the rest take the eager path where the fold engages;
    // the cap interaction has its own test below.
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('folds eager step and wait creates into one createBatch, in order', async () => {
    const eventsCreate = vi.fn();
    const createBatch = successfulCreateBatch();
    const world = createBatchWorld(eventsCreate, createBatch);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(
        stepsAndWait(['s1', 's2', 's3'], 'wait_1'),
        globalThis
      ),
      world,
      run: slotRun,
    });

    expect(createBatch).toHaveBeenCalledTimes(1);
    const [runId, events] = createBatch.mock.calls[0];
    expect(runId).toBe(slotRun.runId);
    // s1 is lazy-inline deferred (cap 1); s2/s3 eager-create via the fold,
    // then the wait — scheduling order preserved.
    expect(
      events.map((e: { event: { eventType: string } }) => e.event.eventType)
    ).toEqual(['step_created', 'step_created', 'wait_created']);
    expect(
      events.map(
        (e: { event: { correlationId: string } }) => e.event.correlationId
      )
    ).toEqual(['s2', 's3', 'wait_1']);
    // No single-event writes for the folded events.
    expect(eventsCreate).not.toHaveBeenCalled();
    expect([...result.createdStepCorrelationIds].sort()).toEqual(['s2', 's3']);
  });

  it('tolerates a per-event 409 exactly like a single-path conflict', async () => {
    const createBatch = vi.fn().mockImplementation(async (_runId, events) => ({
      results: events.map(
        (
          { event }: { event: { eventType: string; correlationId: string } },
          index: number
        ) =>
          index === 0
            ? {
                status: 409,
                error: 'conflict',
                message: 'already created by an earlier delivery',
              }
            : { status: 200, event: { ...event, eventId: slotToEventId(11) } }
      ),
    }));
    const world = createBatchWorld(vi.fn(), createBatch);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(
        stepsAndWait(['s1', 's2', 's3']),
        globalThis
      ),
      world,
      run: slotRun,
    });

    // s1 defers; of the folded pair, the conflicted step (s2) is not owned
    // and the survivor (s3) is.
    expect([...result.createdStepCorrelationIds]).toEqual(['s3']);
  });

  it('fails the suspension on a non-409 per-event failure', async () => {
    const createBatch = vi.fn().mockImplementation(async (_runId, events) => ({
      results: events.map(() => ({
        status: 410,
        error: 'gone',
        message: 'run already finished',
      })),
    }));
    const world = createBatchWorld(vi.fn(), createBatch);

    await expect(
      handleSuspension({
        suspension: new WorkflowSuspension(
          // s1 defers; s2 + s3 form a real (multi-event) batch.
          stepsAndWait(['s1', 's2', 's3']),
          globalThis
        ),
        world,
        run: slotRun,
      })
    ).rejects.toMatchObject({ status: 410 });
  });

  it('keeps the single path when the kill switch disables batching', async () => {
    vi.stubEnv('WORKFLOW_BATCH_TRANSITIONS', '0');
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event,
    }));
    const createBatch = successfulCreateBatch();
    const world = createBatchWorld(eventsCreate, createBatch);

    await handleSuspension({
      suspension: new WorkflowSuspension(
        stepsAndWait(['s1', 's2'], 'w1'),
        globalThis
      ),
      world,
      run: slotRun,
    });

    expect(createBatch).not.toHaveBeenCalled();
    // s1 defers; s2's eager create + the wait go out as single writes.
    expect(eventsCreate).toHaveBeenCalledTimes(2);
  });

  it('keeps the single path when the World lacks createBatch', async () => {
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event,
    }));
    const world = createBatchWorld(eventsCreate);

    await handleSuspension({
      suspension: new WorkflowSuspension(
        stepsAndWait(['s1', 's2']),
        globalThis
      ),
      world,
      run: slotRun,
    });

    expect(eventsCreate).toHaveBeenCalledTimes(1);
  });

  it('leaves the pre-claim path fully inert on a World without createBatch', async () => {
    // world-local and world-postgres do not implement createBatch, so the fold
    // never engages there — but the runtime passes `ownerMessageId` and
    // `allowDeferredBatchWork` unconditionally. Assert those are inert rather
    // than assuming it: the lazy-inline path must be taken with no claims, no
    // deferred work and no slot ceiling, so the caller sends the lazy
    // `step_started` it always did.
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event,
    }));
    const world = createBatchWorld(eventsCreate);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(
        stepsAndWait(['s1', 's2', 's3']),
        globalThis
      ),
      world,
      run: slotRun,
      ownerMessageId: 'msg_owner_1',
      allowDeferredBatchWork: true,
    });

    expect(result.inlineClaims.size).toBe(0);
    expect(result.deferredBatchWork).toBeUndefined();
    expect(result.batchCommittedSlotCeiling).toBeUndefined();
    // The deferred inline step still carries its input for the lazy start.
    expect(result.lazyInlineSteps).toHaveLength(1);
    expect(result.lazyInlineSteps[0].correlationId).toBe('s1');
    expect(result.lazyInlineSteps[0].dehydratedInput).toBeDefined();
    // No step_started rode a batch, so nothing pre-claimed anything.
    for (const [, event] of eventsCreate.mock.calls) {
      expect(event.eventType).not.toBe('step_started');
    }
  });

  it('keeps the single path on a pre-slot-identity run', async () => {
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event,
    }));
    const createBatch = successfulCreateBatch();
    const world = createBatchWorld(eventsCreate, createBatch);

    await handleSuspension({
      suspension: new WorkflowSuspension(
        stepsAndWait(['s1', 's2']),
        globalThis
      ),
      world,
      run: { ...run, specVersion: 5 },
    });

    expect(createBatch).not.toHaveBeenCalled();
    expect(eventsCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps the single path when the suspension carries hook writes', async () => {
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event: { ...event, eventType: event.eventType },
      hook: { hookId: 'hook_1', token: 'tok' },
    }));
    const createBatch = successfulCreateBatch();
    const world = createBatchWorld(eventsCreate, createBatch);
    const pending = stepsAndWait(['s1']) as Map<string, unknown>;
    pending.set('hook_1', {
      type: 'hook' as const,
      correlationId: 'hook_1',
      token: 'order:456',
    });

    await handleSuspension({
      suspension: new WorkflowSuspension(
        pending as ConstructorParameters<typeof WorkflowSuspension>[0],
        globalThis
      ),
      world,
      run: slotRun,
    });

    expect(createBatch).not.toHaveBeenCalled();
  });

  it('routes a lone eager event through the single path, never a batch of one', async () => {
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event,
    }));
    const createBatch = successfulCreateBatch();
    const world = createBatchWorld(eventsCreate, createBatch);

    // Two steps: s1 lazy-defers (cap 1), leaving exactly one eager create.
    const result = await handleSuspension({
      suspension: new WorkflowSuspension(
        stepsAndWait(['s1', 's2']),
        globalThis
      ),
      world,
      run: slotRun,
    });

    expect(createBatch).not.toHaveBeenCalled();
    expect(eventsCreate).toHaveBeenCalledTimes(1);
    expect(eventsCreate).toHaveBeenCalledWith(
      slotRun.runId,
      expect.objectContaining({
        eventType: 'step_created',
        correlationId: 's2',
      }),
      expect.anything()
    );
    expect([...result.createdStepCorrelationIds]).toEqual(['s2']);
  });

  it('chunks a fan-out past MAX_BATCH_FANOUT_EVENTS', async () => {
    const createBatch = successfulCreateBatch();
    const world = createBatchWorld(vi.fn(), createBatch);
    const stepIds = Array.from({ length: 34 }, (_, i) => `s${i + 1}`);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(stepsAndWait(stepIds), globalThis),
      world,
      run: slotRun,
    });

    // s1 defers; the remaining 33 eager creates chunk as 32 + 1.
    expect(createBatch).toHaveBeenCalledTimes(2);
    expect(createBatch.mock.calls[0][1]).toHaveLength(32);
    expect(createBatch.mock.calls[1][1]).toHaveLength(1);
    expect(result.createdStepCorrelationIds.size).toBe(33);
  });

  it('leaves lazy-inline deferred steps out of the batch', async () => {
    // Default inline cap (3): s1..s3 defer their step_created for the lazy
    // start; s4 + s5 eager-create, so the batch carries exactly those two.
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '3');
    const createBatch = successfulCreateBatch();
    const world = createBatchWorld(vi.fn(), createBatch);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(
        stepsAndWait(['s1', 's2', 's3', 's4', 's5']),
        globalThis
      ),
      world,
      run: slotRun,
    });

    expect(result.lazyInlineSteps.map((s) => s.correlationId)).toEqual([
      's1',
      's2',
      's3',
    ]);
    expect(createBatch).toHaveBeenCalledTimes(1);
    expect(createBatch.mock.calls[0][1]).toHaveLength(2);
    expect(
      createBatch.mock.calls[0][1].map(
        (e: { event: { correlationId: string } }) => e.event.correlationId
      )
    ).toEqual(['s4', 's5']);
    expect([...result.createdStepCorrelationIds].sort()).toEqual(['s4', 's5']);
  });

  describe('pre-claimed inline pairs', () => {
    it('folds each inline step as a created+started pair, stamped and claimed', async () => {
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '2');
      const eventsCreate = vi.fn();
      const createBatch = successfulCreateBatch();
      const world = createBatchWorld(eventsCreate, createBatch);

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          stepsAndWait(['s1', 's2', 's3'], 'wait_1'),
          globalThis
        ),
        world,
        run: slotRun,
        ownerMessageId: 'msg_owner_1',
      });

      expect(createBatch).toHaveBeenCalledTimes(1);
      const events = createBatch.mock.calls[0][1];
      // s1/s2 are inline: their pairs lead, adjacent; then s3's eager create
      // and the wait — scheduling order preserved.
      expect(
        events.map((e: { event: { eventType: string } }) => e.event.eventType)
      ).toEqual([
        'step_created',
        'step_started',
        'step_created',
        'step_started',
        'step_created',
        'wait_created',
      ]);
      expect(
        events.map(
          (e: { event: { correlationId: string } }) => e.event.correlationId
        )
      ).toEqual(['s1', 's1', 's2', 's2', 's3', 'wait_1']);
      // The created rows carry the input; the started rows are bare claims
      // stamped with this invocation's ownership and compute instance.
      const s1Created = events[0].event;
      const s1Started = events[1].event;
      expect(s1Created.eventData.input).toBeDefined();
      expect(s1Started.eventData.input).toBeUndefined();
      expect(s1Started.eventData.ownerMessageId).toBe('msg_owner_1');
      expect(events[1].computeInstanceId).toBe(COMPUTE_INSTANCE_ID);
      expect(events[0].computeInstanceId).toBeUndefined();
      // Claims: both inline steps owned, running attempt 1, input attached
      // (batch responses return refs lazily — the body hydrates local bytes).
      expect(result.inlineClaims.size).toBe(2);
      for (const id of ['s1', 's2']) {
        const claim = result.inlineClaims.get(id);
        expect(claim?.owned).toBe(true);
        if (claim?.owned) {
          expect(claim.step.status).toBe('running');
          expect(claim.step.attempt).toBe(1);
          expect(claim.step.input).toBeDefined();
          expect(claim.batchPostSentAtMs).toBeTypeOf('number');
          expect(claim.claimCompletedAtMs).toBeTypeOf('number');
        }
      }
      // Inline steps stay OUT of createdStepCorrelationIds — the started
      // row's verdict (the claim) is their ownership, and the caller's
      // dispatch pass skips inline ids regardless.
      expect([...result.createdStepCorrelationIds]).toEqual(['s3']);
      // The deferral list is unchanged; the caller keys claims off it.
      expect(result.lazyInlineSteps.map((s) => s.correlationId)).toEqual([
        's1',
        's2',
      ]);
      // 6 events at slots 10..15.
      expect(result.batchCommittedSlotCeiling).toBe(15);
      expect(eventsCreate).not.toHaveBeenCalled();
    });

    it('does not fold pairs without the caller ownership stamp', async () => {
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '2');
      const createBatch = successfulCreateBatch();
      const world = createBatchWorld(vi.fn(), createBatch);

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          stepsAndWait(['s1', 's2', 's3', 's4']),
          globalThis
        ),
        world,
        run: slotRun,
      });

      // s1/s2 defer to the lazy path; only the eager creates batch.
      expect(
        createBatch.mock.calls[0][1].map(
          (e: { event: { correlationId: string } }) => e.event.correlationId
        )
      ).toEqual(['s3', 's4']);
      expect(result.inlineClaims.size).toBe(0);
      expect(result.lazyInlineSteps.map((s) => s.correlationId)).toEqual([
        's1',
        's2',
      ]);
    });

    it('records a lost pair as owned:false and keeps the batch alive', async () => {
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '2');
      let slot = 20;
      const createBatch = vi
        .fn()
        .mockImplementation(async (_runId, events) => ({
          results: events.map(
            ({ event }: { event: { correlationId: string } }, index: number) =>
              event.correlationId === 's1'
                ? {
                    status: 409,
                    error: 'conflict',
                    message: `row ${index}: already claimed`,
                  }
                : {
                    status: 200,
                    event: { ...event, eventId: slotToEventId(slot++) },
                  }
          ),
        }));
      const world = createBatchWorld(vi.fn(), createBatch);

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          stepsAndWait(['s1', 's2', 's3']),
          globalThis
        ),
        world,
        run: slotRun,
        ownerMessageId: 'msg_owner_1',
      });

      expect(result.inlineClaims.get('s1')).toEqual({ owned: false });
      expect(result.inlineClaims.get('s2')?.owned).toBe(true);
      expect([...result.createdStepCorrelationIds]).toEqual(['s3']);
    });

    it('keeps the lone inline step on the lazy path (nothing to batch with)', async () => {
      const eventsCreate = vi.fn();
      const createBatch = successfulCreateBatch();
      const world = createBatchWorld(eventsCreate, createBatch);

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(stepsAndWait(['s1']), globalThis),
        world,
        run: slotRun,
        ownerMessageId: 'msg_owner_1',
      });

      // A pair-only batch is the same round trip as the single lazy claim
      // but gives up the optimistic claim/body overlap — so nothing is
      // written at all here; the deferral stands.
      expect(createBatch).not.toHaveBeenCalled();
      expect(eventsCreate).not.toHaveBeenCalled();
      expect(result.inlineClaims.size).toBe(0);
      expect(result.lazyInlineSteps.map((s) => s.correlationId)).toEqual([
        's1',
      ]);
    });

    it('folds a lone inline pair when an eager sibling already batches', async () => {
      const createBatch = successfulCreateBatch();
      const world = createBatchWorld(vi.fn(), createBatch);

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          stepsAndWait(['s1', 's2']),
          globalThis
        ),
        world,
        run: slotRun,
        ownerMessageId: 'msg_owner_1',
      });

      expect(
        createBatch.mock.calls[0][1].map(
          (e: { event: { eventType: string; correlationId: string } }) =>
            `${e.event.eventType}:${e.event.correlationId}`
        )
      ).toEqual(['step_created:s1', 'step_started:s1', 'step_created:s2']);
      expect(result.inlineClaims.get('s1')?.owned).toBe(true);
      expect([...result.createdStepCorrelationIds]).toEqual(['s2']);
    });

    it('keeps pairs whole at the chunk boundary (max inline cap)', async () => {
      // The inline cap clamps at 16, so 16 pairs = exactly 32 rows — one full
      // chunk, pairs adjacent throughout — and the eager overflow spills into
      // the next call. (Pairs always occupy the head rows, so with cap*2 ==
      // MAX_BATCH_FANOUT_EVENTS a straddle is structurally unreachable; the
      // chunker still refuses to split one should those constants diverge.)
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '16');
      const createBatch = successfulCreateBatch();
      const world = createBatchWorld(vi.fn(), createBatch);
      const stepIds = Array.from({ length: 17 }, (_, i) => `s${i + 1}`);

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(stepsAndWait(stepIds), globalThis),
        world,
        run: slotRun,
        ownerMessageId: 'msg_owner_1',
      });

      expect(createBatch).toHaveBeenCalledTimes(2);
      const head = createBatch.mock.calls[0][1];
      expect(head).toHaveLength(32);
      // 16 adjacent created+started pairs, in step order.
      for (let pair = 0; pair < 16; pair++) {
        expect(head[2 * pair].event.eventType).toBe('step_created');
        expect(head[2 * pair + 1].event.eventType).toBe('step_started');
        expect(head[2 * pair + 1].event.correlationId).toBe(
          head[2 * pair].event.correlationId
        );
      }
      const tail = createBatch.mock.calls[1][1];
      expect(
        tail.map(
          (e: { event: { eventType: string; correlationId: string } }) =>
            `${e.event.eventType}:${e.event.correlationId}`
        )
      ).toEqual(['step_created:s17']);
      expect(result.inlineClaims.size).toBe(16);
      for (const claim of result.inlineClaims.values()) {
        expect(claim.owned).toBe(true);
      }
      expect([...result.createdStepCorrelationIds]).toEqual(['s17']);
    });

    it('prefers the readback step entity when the World returns one', async () => {
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
      const serverStartedAt = new Date('2026-08-14T01:02:03.000Z');
      let slot = 30;
      const createBatch = vi
        .fn()
        .mockImplementation(async (_runId, events) => ({
          results: events.map(
            ({
              event,
            }: {
              event: { eventType: string; correlationId: string };
            }) => ({
              status: 200,
              event: { ...event, eventId: slotToEventId(slot++) },
              ...(event.eventType === 'step_started'
                ? {
                    step: {
                      runId: slotRun.runId,
                      stepId: event.correlationId,
                      stepName: event.correlationId,
                      status: 'running',
                      attempt: 1,
                      createdAt: serverStartedAt,
                      updatedAt: serverStartedAt,
                      startedAt: serverStartedAt,
                    },
                  }
                : {}),
            })
          ),
        }));
      const world = createBatchWorld(vi.fn(), createBatch);

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          stepsAndWait(['s1', 's2']),
          globalThis
        ),
        world,
        run: slotRun,
        ownerMessageId: 'msg_owner_1',
      });

      const claim = result.inlineClaims.get('s1');
      expect(claim?.owned).toBe(true);
      if (claim?.owned) {
        expect(claim.step.startedAt).toEqual(serverStartedAt);
        // Input is still re-attached locally over the readback entity.
        expect(claim.step.input).toBeDefined();
      }
    });
  });

  describe('parallel chunks, per-chunk publishes, deferred work', () => {
    const queueName = '__wkf_workflow_test-workflow' as ValidQueueName;
    const stepDispatch = () => ({
      queueName,
      getTraceCarrier: vi.fn().mockResolvedValue({ traceparent: '00-abc' }),
    });

    /**
     * A createBatch mock whose calls block until released, so tests control
     * per-chunk commit timing. Results mirror successfulCreateBatch.
     */
    function gatedCreateBatch(firstSlot = 10) {
      let slot = firstSlot;
      const releases: (() => void)[] = [];
      const createBatch = vi.fn().mockImplementation(
        (_runId, events) =>
          new Promise((resolve) => {
            releases.push(() =>
              resolve({
                results: events.map(
                  ({ event }: { event: { eventType: string } }) => ({
                    status: 200,
                    event: { ...event, eventId: slotToEventId(slot++) },
                  })
                ),
              })
            );
          })
      );
      return { createBatch, releases };
    }

    function queueWorld(
      createBatch: ReturnType<typeof vi.fn>,
      queue = vi.fn().mockResolvedValue({ messageId: 'msg_q' })
    ): { world: World; queue: ReturnType<typeof vi.fn> } {
      const world = {
        events: { create: vi.fn(), createBatch },
        queue,
        getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
      } as unknown as World;
      return { world, queue };
    }

    const tick = () => new Promise((resolve) => setImmediate(resolve));
    /** 'pending' | 'settled' without awaiting the probed promise. */
    const probe = async (p: Promise<unknown> | undefined) => {
      let state = 'pending';
      p?.then(
        () => {
          state = 'settled';
        },
        () => {
          state = 'settled';
        }
      );
      await tick();
      return state;
    };

    it('POSTs every chunk concurrently instead of serially', async () => {
      // 34 steps, no pairs (no ownerMessageId): s1 defers lazily, 33 eager
      // creates chunk as 32 + 1 — and BOTH POSTs must be in flight before
      // either commits.
      const { createBatch, releases } = gatedCreateBatch();
      const { world } = queueWorld(createBatch);
      const stepIds = Array.from({ length: 34 }, (_, i) => `s${i + 1}`);

      const pending = handleSuspension({
        suspension: new WorkflowSuspension(stepsAndWait(stepIds), globalThis),
        world,
        run: slotRun,
      });
      await vi.waitFor(() => {
        expect(createBatch).toHaveBeenCalledTimes(2);
      });
      for (const release of releases) release();
      const result = await pending;
      expect(result.createdStepCorrelationIds.size).toBe(33);
    });

    it('returns off the pair chunk; trailing chunks ride deferredBatchWork', async () => {
      // 34 steps with a pair: chunk 1 = pair + 30 eager (32 rows), chunk 2 =
      // 3 eager. Releasing only chunk 1 must resolve the handler with the
      // claims; chunk 2 settles deferredBatchWork later.
      const { createBatch, releases } = gatedCreateBatch();
      const { world, queue } = queueWorld(createBatch);
      const stepIds = Array.from({ length: 34 }, (_, i) => `s${i + 1}`);

      const pending = handleSuspension({
        suspension: new WorkflowSuspension(stepsAndWait(stepIds), globalThis),
        world,
        run: slotRun,
        ownerMessageId: 'msg_owner_1',
        stepDispatch: stepDispatch(),
        allowDeferredBatchWork: true,
      });
      await vi.waitFor(() => {
        expect(createBatch).toHaveBeenCalledTimes(2);
      });
      releases[0]();
      const result = await pending;

      // The handler returned with chunk 2 still uncommitted.
      expect(result.inlineClaims.get('s1')?.owned).toBe(true);
      expect(result.deferredBatchWork).toBeDefined();
      expect(await probe(result.deferredBatchWork)).toBe('pending');
      // Every eager step is claimed for in-flush publishing up front, so
      // the caller's dispatch pass skips them all.
      expect(result.queuedStepCorrelationIds.size).toBe(33);

      // Chunk 1's publishes fire off its own commit — 30 messages — while
      // chunk 2's three wait for theirs.
      await vi.waitFor(() => {
        expect(queue).toHaveBeenCalledTimes(30);
      });
      const publishedNow = queue.mock.calls.map((call) => call[1].stepId);
      expect(publishedNow).not.toContain('s33');

      releases[1]();
      // biome-ignore lint/style/noNonNullAssertion: asserted defined above
      await result.deferredBatchWork!;
      expect(queue).toHaveBeenCalledTimes(33);
      // Message shape and idempotency key match the caller's dispatch pass.
      const [calledQueueName, payload, opts] = queue.mock.calls[0];
      expect(calledQueueName).toBe(queueName);
      expect(payload).toMatchObject({
        runId: slotRun.runId,
        stepName: payload.stepId,
        traceCarrier: { traceparent: '00-abc' },
      });
      expect(opts.idempotencyKey).toBe(
        stepDispatchIdempotencyKey(payload.stepId, payload.stepName)
      );
    });

    it('surfaces a trailing-chunk failure through deferredBatchWork, not the return', async () => {
      let call = 0;
      let releaseFailure: (() => void) | undefined;
      const createBatch = vi.fn().mockImplementation((_runId, events) => {
        call += 1;
        if (call === 2) {
          return new Promise((_resolve, reject) => {
            releaseFailure = () =>
              reject(
                new WorkflowWorldError('trailing chunk exploded', {
                  status: 500,
                })
              );
          });
        }
        let slot = 10;
        return Promise.resolve({
          results: events.map(({ event }: { event: object }) => ({
            status: 200,
            event: { ...event, eventId: slotToEventId(slot++) },
          })),
        });
      });
      const { world } = queueWorld(createBatch);
      const stepIds = Array.from({ length: 34 }, (_, i) => `s${i + 1}`);

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(stepsAndWait(stepIds), globalThis),
        world,
        run: slotRun,
        ownerMessageId: 'msg_owner_1',
        stepDispatch: stepDispatch(),
        allowDeferredBatchWork: true,
      });
      expect(result.inlineClaims.get('s1')?.owned).toBe(true);
      // biome-ignore lint/style/noNonNullAssertion: set by the second call
      releaseFailure!();
      await expect(result.deferredBatchWork).rejects.toMatchObject({
        message: expect.stringContaining('trailing chunk exploded'),
      });
    });

    it('mixed bad step + large fan-out: deferred rejection still surfaces through deferredBatchWork', async () => {
      // A step whose args fail serialization is finalized on the sequential
      // path while the healthy fan-out still defers trailing chunk commits
      // and publishes. The caller's failed-step replay path must join
      // deferredBatchWork before continuing (runtime.ts), so its rejection
      // is observable — this pins the handler-side contract: the failure
      // set and the still-pending deferred work coexist on one result.
      class Unserializable {
        secret = 'not-a-pojo';
      }
      let call = 0;
      let releaseFailure: (() => void) | undefined;
      const createBatch = vi.fn().mockImplementation((_runId, events) => {
        call += 1;
        if (call === 2) {
          return new Promise((_resolve, reject) => {
            releaseFailure = () =>
              reject(
                new WorkflowWorldError('trailing publish failed', {
                  status: 500,
                })
              );
          });
        }
        let slot = 10;
        return Promise.resolve({
          results: events.map(({ event }: { event: object }) => ({
            status: 200,
            event: { ...event, eventId: slotToEventId(slot++) },
          })),
        });
      });
      const eventsCreate = vi
        .fn()
        .mockImplementation(async (_runId, event) => ({ event }));
      const world = {
        events: { create: eventsCreate, createBatch },
        queue: vi.fn().mockResolvedValue({ messageId: 'msg_q' }),
        getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
      } as unknown as World;

      const pending = stepsAndWait(
        Array.from({ length: 34 }, (_, i) => `s${i + 1}`)
      ) as Map<string, { args: unknown[] }>;
      // biome-ignore lint/style/noNonNullAssertion: seeded above
      pending.get('s5')!.args = [new Unserializable()];

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(
          pending as ConstructorParameters<typeof WorkflowSuspension>[0],
          globalThis
        ),
        world,
        run: slotRun,
        ownerMessageId: 'msg_owner_1',
        stepDispatch: stepDispatch(),
        allowDeferredBatchWork: true,
      });

      // The bad step was finalized sequentially (step_created placeholder +
      // step_failed), dropped out of the batch fold…
      expect([...result.failedStepCorrelationIds]).toEqual(['s5']);
      expect(
        eventsCreate.mock.calls.map(([, event]) => [
          event.eventType,
          event.correlationId,
        ])
      ).toEqual([
        ['step_created', 's5'],
        ['step_failed', 's5'],
      ]);
      // …while the healthy fan-out still handed back live deferred work.
      expect(result.deferredBatchWork).toBeDefined();
      expect(await probe(result.deferredBatchWork)).toBe('pending');

      // A trailing rejection surfaces through the deferred promise — the
      // caller's failed-step path awaits it before replaying.
      // biome-ignore lint/style/noNonNullAssertion: set by the second call
      releaseFailure!();
      await expect(result.deferredBatchWork).rejects.toMatchObject({
        message: expect.stringContaining('trailing publish failed'),
      });
    });

    it('settles the trailing chunk before a pair-chunk failure escapes', async () => {
      // settlePhase's invariant: a phase's write set must be final before a
      // failure escapes, or a sibling create lands during the caller's replay
      // restart. `deferredBatchWork` never reaches the caller when
      // handleSuspension throws, so the pair-chunk failure path has to join
      // the trailing work itself.
      let rejectPairChunk: ((err: unknown) => void) | undefined;
      let releaseTrailing: (() => void) | undefined;
      let trailingSettled = false;
      let call = 0;
      const createBatch = vi.fn().mockImplementation((_runId, events) => {
        call += 1;
        if (call === 1) {
          return new Promise((_resolve, reject) => {
            rejectPairChunk = reject;
          });
        }
        return new Promise((resolve) => {
          releaseTrailing = () => {
            trailingSettled = true;
            let slot = 100;
            resolve({
              results: events.map(({ event }: { event: object }) => ({
                status: 200,
                event: { ...event, eventId: slotToEventId(slot++) },
              })),
            });
          };
        });
      });
      const { world } = queueWorld(createBatch);
      const stepIds = Array.from({ length: 34 }, (_, i) => `s${i + 1}`);

      const pending = handleSuspension({
        suspension: new WorkflowSuspension(stepsAndWait(stepIds), globalThis),
        world,
        run: slotRun,
        ownerMessageId: 'msg_owner_1',
        stepDispatch: stepDispatch(),
        allowDeferredBatchWork: true,
      });
      await vi.waitFor(() => {
        expect(createBatch).toHaveBeenCalledTimes(2);
      });
      // biome-ignore lint/style/noNonNullAssertion: set by the first call
      rejectPairChunk!(
        new WorkflowWorldError('pair chunk exploded', { status: 500 })
      );
      // The rejection must NOT escape while chunk 2 is outstanding.
      expect(await probe(pending)).toBe('pending');
      expect(trailingSettled).toBe(false);

      // biome-ignore lint/style/noNonNullAssertion: set by the second call
      releaseTrailing!();
      await expect(pending).rejects.toMatchObject({
        message: expect.stringContaining('pair chunk exploded'),
      });
      expect(trailingSettled).toBe(true);
    });

    it('awaits everything at return without the opt-in', async () => {
      const { createBatch, releases } = gatedCreateBatch();
      const { world } = queueWorld(createBatch);
      const stepIds = Array.from({ length: 34 }, (_, i) => `s${i + 1}`);

      const pending = handleSuspension({
        suspension: new WorkflowSuspension(stepsAndWait(stepIds), globalThis),
        world,
        run: slotRun,
        ownerMessageId: 'msg_owner_1',
        stepDispatch: stepDispatch(),
      });
      await vi.waitFor(() => {
        expect(createBatch).toHaveBeenCalledTimes(2);
      });
      releases[0]();
      // Chunk 2 unreleased: the handler must still be pending.
      expect(await probe(pending)).toBe('pending');
      releases[1]();
      const result = await pending;
      expect(result.deferredBatchWork).toBeUndefined();
      expect(result.inlineClaims.get('s1')?.owned).toBe(true);
    });
  });
});

describe('step-argument serialization failure', () => {
  // A value the workflow serializer cannot dehydrate: a class instance with
  // no registered serde model. Mirrors serialization.test.ts's unsupported
  // type coverage — dehydrateStepArguments throws a SerializationError.
  class Unserializable {
    secret = 'not-a-pojo';
  }

  function stepItem(id: string, args: unknown[] = []) {
    return {
      type: 'step' as const,
      correlationId: id,
      stepName: id,
      args,
    };
  }

  // Finalization requires a dispatch target: a caller without one (the
  // terminal drain) has no replay to observe the failure — see the
  // stepDispatch gate in the per-step op.
  const stepDispatch = () => ({
    queueName: '__wkf_workflow_test-workflow' as ValidQueueName,
    getTraceCarrier: vi.fn().mockResolvedValue({}),
  });

  it('finalizes the step as step_created + step_failed instead of rejecting the suspension', async () => {
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event,
    }));
    const world = createWorld(eventsCreate);
    const pending = new Map([
      ['s_bad', stepItem('s_bad', [new Unserializable()])],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
      stepDispatch: stepDispatch(),
    });

    // The suspension itself resolves — the failure is scoped to the step.
    expect(eventsCreate).toHaveBeenCalledTimes(2);
    const [createdCall, failedCall] = eventsCreate.mock.calls;
    expect(createdCall[1]).toMatchObject({
      eventType: 'step_created',
      correlationId: 's_bad',
      eventData: expect.objectContaining({
        stepName: 's_bad',
        workflowName: run.workflowName,
      }),
    });
    expect(failedCall[1]).toMatchObject({
      eventType: 'step_failed',
      correlationId: 's_bad',
      eventData: expect.objectContaining({ stepName: 's_bad' }),
    });
    expect([...result.failedStepCorrelationIds]).toEqual(['s_bad']);
    // Not owned for dispatch, not deferred for lazy-inline execution: the
    // step is terminal.
    expect(result.createdStepCorrelationIds.size).toBe(0);
    expect(result.lazyInlineSteps).toEqual([]);
  });

  it('round-trips the SerializationError through the step_failed payload', async () => {
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event,
    }));
    const world = createWorld(eventsCreate);
    const pending = new Map([
      ['s_bad', stepItem('s_bad', [new Unserializable()])],
    ]);

    await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
      stepDispatch: stepDispatch(),
    });

    const failedEvent = eventsCreate.mock.calls.find(
      ([, event]) => event.eventType === 'step_failed'
    )?.[1];
    expect(failedEvent).toBeDefined();
    const hydrated = (await hydrateStepError(
      failedEvent.eventData.error,
      run.runId,
      undefined
    )) as Error;
    expect(hydrated).toBeInstanceOf(Error);
    expect(hydrated.name).toBe('SerializationError');
    expect(hydrated.message).toContain('Failed to serialize step arguments');
  });

  it('finalizes the bad step while healthy siblings proceed', async () => {
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event,
    }));
    const world = createWorld(eventsCreate);
    // Default inline cap (3): both steps are designated lazy-inline, but the
    // bad one is finalized before deferral, so only the healthy step defers.
    const pending = new Map([
      ['s_bad', stepItem('s_bad', [new Unserializable()])],
      ['s_good', stepItem('s_good', ['fine'])],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
      stepDispatch: stepDispatch(),
    });

    expect([...result.failedStepCorrelationIds]).toEqual(['s_bad']);
    expect(result.lazyInlineSteps.map((s) => s.correlationId)).toEqual([
      's_good',
    ]);
    const eventTypes = eventsCreate.mock.calls.map(([, event]) => [
      event.eventType,
      event.correlationId,
    ]);
    expect(eventTypes).toEqual([
      ['step_created', 's_bad'],
      ['step_failed', 's_bad'],
    ]);
  });

  it('drops the bad step out of the batched fan-out onto the sequential path', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
    try {
      const slotRun: WorkflowRun = { ...run, specVersion: 6 };
      let slot = 10;
      const createBatch = vi
        .fn()
        .mockImplementation(async (_runId, events) => ({
          results: events.map(({ event }: { event: object }) => ({
            status: 200,
            event: { ...event, eventId: slotToEventId(slot++) },
          })),
        }));
      const eventsCreate = vi
        .fn()
        .mockImplementation(async (_runId, event) => ({ event }));
      const world = {
        events: { create: eventsCreate, createBatch },
        // The batch flush publishes chunk step messages when a dispatch
        // target is provided.
        queue: vi.fn().mockResolvedValue({ messageId: 'msg_1' }),
        getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
      } as unknown as World;
      // s1 defers (cap 1); s_bad fails serialization; s3 + s4 fold into the
      // batch. The bad step's two writes go through the single-event path.
      const pending = new Map([
        ['s1', stepItem('s1')],
        ['s_bad', stepItem('s_bad', [new Unserializable()])],
        ['s3', stepItem('s3')],
        ['s4', stepItem('s4')],
      ]);

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(pending, globalThis),
        world,
        run: slotRun,
        stepDispatch: stepDispatch(),
      });

      expect([...result.failedStepCorrelationIds]).toEqual(['s_bad']);
      expect(createBatch).toHaveBeenCalledTimes(1);
      expect(
        createBatch.mock.calls[0][1].map(
          (e: { event: { correlationId: string } }) => e.event.correlationId
        )
      ).toEqual(['s3', 's4']);
      expect(
        eventsCreate.mock.calls.map(([, event]) => [
          event.eventType,
          event.correlationId,
        ])
      ).toEqual([
        ['step_created', 's_bad'],
        ['step_failed', 's_bad'],
      ]);
      expect([...result.createdStepCorrelationIds].sort()).toEqual([
        's3',
        's4',
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('tolerates a concurrent handler having already finalized the step', async () => {
    // Both writes conflict: a concurrent replay hit the same deterministic
    // serialization failure and wrote step_created + step_failed first.
    const eventsCreate = vi
      .fn()
      .mockRejectedValue(new EntityConflictError('already exists'));
    const world = createWorld(eventsCreate);
    const pending = new Map([
      ['s_bad', stepItem('s_bad', [new Unserializable()])],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
      stepDispatch: stepDispatch(),
    });

    expect([...result.failedStepCorrelationIds]).toEqual(['s_bad']);
  });

  it('skips finalization when the run has already finished', async () => {
    const eventsCreate = vi
      .fn()
      .mockRejectedValue(new RunExpiredError('run is gone'));
    const world = createWorld(eventsCreate);
    const pending = new Map([
      ['s_bad', stepItem('s_bad', [new Unserializable()])],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
      stepDispatch: stepDispatch(),
    });

    // Nothing to observe the failure — no replay is forced.
    expect(result.failedStepCorrelationIds.size).toBe(0);
  });

  it('rejects the suspension when step_failed cannot be written after step_created landed', async () => {
    // The two finalization writes are separate durable writes. If the second
    // fails transiently, the suspension must reject so the message
    // redelivers — leaving a lone placeholder step_created behind. Recovery
    // for that window lives in the step executor: the placeholder carries a
    // structural flag (see unserializable-step.ts) that the executor
    // completes as the intended step_failed instead of running user code
    // with placeholder arguments (covered in step-executor.test.ts).
    const writeError = new Error('storage unavailable');
    const eventsCreate = vi
      .fn()
      .mockImplementationOnce(async (_runId, event) => ({ event }))
      .mockRejectedValueOnce(writeError);
    const world = createWorld(eventsCreate);
    const pending = new Map([
      ['s_bad', stepItem('s_bad', [new Unserializable()])],
    ]);

    await expect(
      handleSuspension({
        suspension: new WorkflowSuspension(pending, globalThis),
        world,
        run,
        stepDispatch: stepDispatch(),
      })
    ).rejects.toBe(writeError);

    // The lone step_created that redelivery will find carries the
    // recoverable placeholder, not a genuine-looking empty input.
    expect(eventsCreate).toHaveBeenCalledTimes(2);
    const createdEvent = eventsCreate.mock.calls[0][1];
    expect(createdEvent.eventType).toBe('step_created');
    const hydrated = await hydrateStepArguments(
      createdEvent.eventData.input,
      run.runId,
      undefined,
      []
    );
    expect(isUnserializableStepInputPlaceholder(hydrated)).toBe(true);
  });

  it('rethrows instead of finalizing when no stepDispatch is provided (terminal drain)', async () => {
    // The drain caller (drainPendingQueueItems) passes no stepDispatch and
    // swallows the rejection: a run that is already completing must not
    // gain step_created + step_failed rows nothing can ever observe.
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event,
    }));
    const world = createWorld(eventsCreate);
    const pending = new Map([
      ['s_bad', stepItem('s_bad', [new Unserializable()])],
    ]);

    await expect(
      handleSuspension({
        suspension: new WorkflowSuspension(pending, globalThis),
        world,
        run,
      })
    ).rejects.toMatchObject({ name: 'SerializationError' });
    expect(eventsCreate).not.toHaveBeenCalled();
  });
});
