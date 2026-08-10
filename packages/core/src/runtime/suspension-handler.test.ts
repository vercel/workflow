import { runInNewContext } from 'node:vm';
import {
  FatalError,
  PreconditionFailedError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  SPEC_VERSION_CURRENT,
  type ValidQueueName,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowSuspension } from '../global.js';
import { stepDispatchIdempotencyKey } from './helpers.js';
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
});

describe('resilient step dispatch', () => {
  const queueName = '__wkf_workflow_test-workflow' as ValidQueueName;

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

  it('falls back to create-only when the world enforces the precondition guard', async () => {
    const { world, eventsCreate, queue } = createQueueWorld({
      capabilities: { preconditionGuard: true },
    });

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(fourStepsPending(), globalThis),
      world,
      run: cborRun,
      stepDispatch: stepDispatch(),
    });

    // The guarded create can be 412-rejected; a payload-carrying message
    // would let the consumer materialize the rejected step. Sequential path:
    // create here, caller dispatches.
    expect(queue).not.toHaveBeenCalled();
    expect(eventsCreate).toHaveBeenCalledWith(
      run.runId,
      expect.objectContaining({
        eventType: 'step_created',
        correlationId: 's4',
      }),
      expect.anything()
    );
    expect(result.queuedStepCorrelationIds.size).toBe(0);
    expect(result.createdStepCorrelationIds).toContain('s4');
  });

  it('stays sequential under an enforced guard regardless of other capabilities', async () => {
    // The guard gate is deliberately not liftable by backend-side revocation
    // bookkeeping: nothing orders a slow guarded create's eventual 412 before
    // the consumer's redelivery re-ensure, so no capability may re-enable the
    // payload-carrying publish while creates are guarded.
    const { world, queue } = createQueueWorld({
      capabilities: {
        preconditionGuard: true,
        // Unknown/extra capability flags must not lift the gate.
        ...({ resilientStepDispatch: true } as Record<string, boolean>),
      } as World['capabilities'],
    });

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(fourStepsPending(), globalThis),
      world,
      run: cborRun,
      stepDispatch: stepDispatch(),
    });

    expect(queue).not.toHaveBeenCalled();
    expect(result.queuedStepCorrelationIds.size).toBe(0);
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

  it('falls back to create-only when WORKFLOW_RESILIENT_STEP_DISPATCH=0', async () => {
    const prev = process.env.WORKFLOW_RESILIENT_STEP_DISPATCH;
    process.env.WORKFLOW_RESILIENT_STEP_DISPATCH = '0';
    try {
      const { world, queue } = createQueueWorld();

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(fourStepsPending(), globalThis),
        world,
        run: cborRun,
        stepDispatch: stepDispatch(),
      });

      expect(queue).not.toHaveBeenCalled();
      expect(result.queuedStepCorrelationIds.size).toBe(0);
    } finally {
      if (prev === undefined) {
        delete process.env.WORKFLOW_RESILIENT_STEP_DISPATCH;
      } else {
        process.env.WORKFLOW_RESILIENT_STEP_DISPATCH = prev;
      }
    }
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
