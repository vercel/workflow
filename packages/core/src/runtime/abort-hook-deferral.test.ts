import { EntityConflictError, PreconditionFailedError } from '@workflow/errors';
import { slotToEventId, type WorkflowRun, type World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type QueueItem, WorkflowSuspension } from '../global.js';
import { pendingHookCreation } from './pending-hook-creations.js';
import { handleSuspension } from './suspension-handler.js';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

/**
 * `handleSuspension` with deferred abort-hook creation: a workflow
 * `AbortController`'s system-hook `hook_created` is written alongside the
 * suspension's other writes, but the handler returns (and the inline step body
 * can start) without waiting for it. See
 * `SuspensionHandlerResult.deferredHookWork`.
 */

const run: WorkflowRun = {
  runId: 'wrun_abort_defer',
  workflowName: 'test-workflow',
  status: 'running',
  input: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  startedAt: new Date(),
  deploymentId: 'test-deployment',
};
const slotRun: WorkflowRun = { ...run, specVersion: 6 };

const step = (id: string) =>
  [
    id,
    { type: 'step' as const, correlationId: id, stepName: id, args: [] },
  ] as const;
const abortHook = (id: string, extra: Record<string, unknown> = {}) =>
  [
    id,
    {
      type: 'hook' as const,
      correlationId: id,
      token: `abrt_${id}`,
      isWebhook: false,
      isSystem: true,
      ...extra,
    },
  ] as const;
const userHook = (id: string) =>
  [
    id,
    { type: 'hook' as const, correlationId: id, token: `tok-${id}` },
  ] as const;

function suspensionOf(
  ...items: ReadonlyArray<readonly [string, unknown]>
): WorkflowSuspension {
  return new WorkflowSuspension(
    new Map(items as Array<[string, QueueItem]>),
    globalThis
  );
}

/** A gate a test opens by hand. */
function gate() {
  let open!: () => void;
  let fail!: (err: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A World whose single-event creates answer through `onCreate` and whose
 * `createBatch` (when `batch` is set) answers every row with a 200 at
 * consecutive slots.
 */
function worldWith(
  onCreate: (event: { eventType: string; correlationId?: string }) => unknown,
  options: { batch?: boolean; batchDelayMs?: number } = {}
): { world: World; create: ReturnType<typeof vi.fn> } {
  let slot = 10;
  const create = vi.fn(async (_runId, event) => {
    await onCreate(event);
    return { event: { ...event, eventId: slotToEventId(slot++) } };
  });
  const createBatch = vi.fn(async (_runId, events) => {
    if (options.batchDelayMs) await delay(options.batchDelayMs);
    return {
      results: events.map(({ event }: { event: Record<string, unknown> }) => ({
        status: 200,
        event: { ...event, eventId: slotToEventId(slot++) },
      })),
    };
  });
  return {
    world: {
      events: { create, ...(options.batch ? { createBatch } : {}) },
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as World,
    create,
  };
}

/** Whether `promise` has settled after the current macrotask drains. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await delay(0);
  return settled;
}

describe('deferred abort-hook creation', () => {
  beforeEach(() => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the pre-claimed pair without waiting for the hook creates (batched path)', async () => {
    // The shape eve produces at the start of every turn: two controllers
    // constructed and their signals handed to the turn's first step.
    const hookWrite = gate();
    const { world, create } = worldWith(
      async (event) => {
        if (event.eventType === 'hook_created') await hookWrite.promise;
      },
      { batch: true }
    );

    const result = await handleSuspension({
      suspension: suspensionOf(
        abortHook('hook_turn'),
        abortHook('hook_steer'),
        step('s_turn')
      ),
      world,
      run: slotRun,
      ownerMessageId: 'msg_1',
      allowDeferredBatchWork: true,
    });

    // The body's claim is settled and handed back while both hook creates
    // are still in flight.
    expect(result.inlineClaims.get('s_turn')?.owned).toBe(true);
    expect(
      create.mock.calls.map(([, event]) => event.eventType).sort()
    ).toEqual(['hook_created', 'hook_created']);
    expect(result.deferredHookWork).toBeDefined();
    expect(await isSettled(result.deferredHookWork!)).toBe(false);
    expect(await isSettled(result.deferredBatchWork!)).toBe(false);
    // The tokens are registered for an in-process step-side abort.
    expect(pendingHookCreation('abrt_hook_turn')).toBeDefined();
    expect(pendingHookCreation('abrt_hook_steer')).toBeDefined();
    // Every input the caller branches on is what it was.
    expect(result.hasHookEvents).toBe(true);
    expect(result.hasHookConflict).toBe(false);
    expect(result.hookCreationMs).toBe(0);
    expect(result.eventLogCarriedForward).toBe(false);

    hookWrite.open();
    await result.deferredHookWork;
    await result.deferredBatchWork;
    expect(pendingHookCreation('abrt_hook_turn')).toBeUndefined();
    expect(pendingHookCreation('abrt_hook_steer')).toBeUndefined();
  });

  it('returns the lazy inline step without waiting for the hook create (single-event path)', async () => {
    const hookWrite = gate();
    const { world } = worldWith(async (event) => {
      if (event.eventType === 'hook_created') await hookWrite.promise;
    });

    const result = await handleSuspension({
      suspension: suspensionOf(abortHook('hook_a'), step('s_lazy')),
      world,
      run,
      ownerMessageId: 'msg_1',
      allowDeferredBatchWork: true,
    });

    // Before, the caller could post this step's lazy claim only after the
    // hook create committed: two round trips in sequence before the body.
    expect(result.lazyInlineSteps.map((s) => s.correlationId)).toEqual([
      's_lazy',
    ]);
    expect(await isSettled(result.deferredHookWork!)).toBe(false);
    hookWrite.open();
    await result.deferredBatchWork;
  });

  it.each([
    [
      'the caller did not opt in',
      { allowDeferredBatchWork: false },
      [abortHook('hook_a'), step('s1')],
    ],
    ['the kill switch is set', { env: '0' }, [abortHook('hook_a'), step('s1')]],
    [
      'the kill switch is set (false)',
      { env: 'false' },
      [abortHook('hook_a'), step('s1')],
    ],
    ['the hook is a user hook', {}, [userHook('hook_u'), step('s1')]],
    [
      'the abort hook is also aborted this pass',
      {},
      [abortHook('hook_a', { abortRequested: true }), step('s1')],
    ],
    [
      'the abort hook is also disposed this pass',
      {},
      [abortHook('hook_a', { disposed: true }), step('s1')],
    ],
    ['no step runs inline', {}, [abortHook('hook_a')]],
  ] as const)('waits for the hook create when %s', async (_label, opts, items) => {
    if ('env' in opts) {
      vi.stubEnv('WORKFLOW_DEFER_ABORT_HOOK_CREATION', opts.env);
    }
    const hookWrite = gate();
    const { world } = worldWith(async (event) => {
      if (event.eventType === 'hook_created') await hookWrite.promise;
    });

    const pending = handleSuspension({
      suspension: suspensionOf(...items),
      world,
      run,
      ownerMessageId: 'msg_1',
      allowDeferredBatchWork:
        'allowDeferredBatchWork' in opts ? opts.allowDeferredBatchWork : true,
    });

    expect(await isSettled(pending)).toBe(false);
    hookWrite.open();
    const result = await pending;
    expect(result.deferredHookWork).toBeUndefined();
  });

  it('defers only the abort hook when a user hook is created alongside it', async () => {
    const userWrite = gate();
    const abortWrite = gate();
    const { world } = worldWith(async (event) => {
      if (event.correlationId === 'hook_u') await userWrite.promise;
      if (event.correlationId === 'hook_a') await abortWrite.promise;
    });

    const pending = handleSuspension({
      suspension: suspensionOf(
        userHook('hook_u'),
        abortHook('hook_a'),
        step('s1')
      ),
      world,
      run,
      ownerMessageId: 'msg_1',
      allowDeferredBatchWork: true,
    });

    // The user hook gates the return exactly as before...
    expect(await isSettled(pending)).toBe(false);
    userWrite.open();
    const result = await pending;
    // ...and the abort hook does not.
    expect(await isSettled(result.deferredHookWork!)).toBe(false);
    abortWrite.open();
    await result.deferredBatchWork;
  });

  it('surfaces a failed deferred create through the deferred work, not the return', async () => {
    const boom = new Error('hook write failed');
    const { world } = worldWith(async (event) => {
      if (event.eventType === 'hook_created') {
        await delay(5);
        throw boom;
      }
    });

    const result = await handleSuspension({
      suspension: suspensionOf(abortHook('hook_a'), step('s1')),
      world,
      run,
      ownerMessageId: 'msg_1',
      allowDeferredBatchWork: true,
    });

    await expect(result.deferredHookWork).rejects.toBe(boom);
    await expect(result.deferredBatchWork).rejects.toBe(boom);
    // The registry entry clears on failure too, so a step-side abort is not
    // held on a write that will never commit.
    expect(pendingHookCreation('abrt_hook_a')).toBeUndefined();
  });

  it('prefers a 412 from the deferred create when joining with the trailing batch work', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
    const { world } = worldWith(
      async (event) => {
        if (event.eventType === 'hook_created') {
          throw new PreconditionFailedError('stale');
        }
      },
      { batch: true }
    );

    const result = await handleSuspension({
      suspension: suspensionOf(abortHook('hook_a'), step('s1'), step('s2')),
      world,
      run: slotRun,
      ownerMessageId: 'msg_1',
      allowDeferredBatchWork: true,
    });

    await expect(result.deferredBatchWork).rejects.toSatisfy((err) =>
      PreconditionFailedError.is(err)
    );
  });

  it('treats an already-existing abort hook as created, like the gating path', async () => {
    const { world } = worldWith(async (event) => {
      if (event.eventType === 'hook_created') {
        throw new EntityConflictError('Hook already exists');
      }
    });

    const result = await handleSuspension({
      suspension: suspensionOf(abortHook('hook_a'), step('s1')),
      world,
      run,
      ownerMessageId: 'msg_1',
      allowDeferredBatchWork: true,
    });

    await expect(result.deferredBatchWork).resolves.toBeUndefined();
  });

  it('settles the deferred creates before a failing suspension rejects', async () => {
    const hookWrite = gate();
    let hookSettled = false;
    const { world } = worldWith(async (event) => {
      if (event.eventType === 'hook_created') {
        await hookWrite.promise;
        hookSettled = true;
      }
      if (event.eventType === 'step_created') {
        throw new PreconditionFailedError('stale');
      }
    });

    // s1 is inline (lazy, no write); s2's eager create is refused as stale.
    const pending = handleSuspension({
      suspension: suspensionOf(abortHook('hook_a'), step('s1'), step('s2')),
      world,
      run,
      ownerMessageId: 'msg_1',
      allowDeferredBatchWork: true,
    });
    pending.catch(() => {});

    // Nothing escapes while the deferred create is still in flight: the
    // caller restarts the replay off this rejection, and a create landing
    // after that would commit an event from the abandoned replay.
    expect(await isSettled(pending)).toBe(false);
    hookWrite.open();
    await expect(pending).rejects.toSatisfy((err) =>
      PreconditionFailedError.is(err)
    );
    expect(hookSettled).toBe(true);
  });

  it('measures the return with a slow hook write', async () => {
    // Unit-level timing, not a production number: a hook create that takes
    // HOOK_MS against a pair commit that takes PAIR_MS. Before, the return
    // (and so the inline body) waited for the slower of the two.
    const HOOK_MS = 120;
    const PAIR_MS = 15;
    const measure = async (deferEnv: string | undefined) => {
      if (deferEnv === undefined) {
        vi.stubEnv('WORKFLOW_DEFER_ABORT_HOOK_CREATION', '');
      } else {
        vi.stubEnv('WORKFLOW_DEFER_ABORT_HOOK_CREATION', deferEnv);
      }
      const { world } = worldWith(
        async (event) => {
          if (event.eventType === 'hook_created') await delay(HOOK_MS);
        },
        { batch: true, batchDelayMs: PAIR_MS }
      );
      const startedAt = performance.now();
      const result = await handleSuspension({
        suspension: suspensionOf(
          abortHook('hook_turn'),
          abortHook('hook_steer'),
          step('s_turn')
        ),
        world,
        run: slotRun,
        ownerMessageId: 'msg_1',
        allowDeferredBatchWork: true,
      });
      const returnedMs = performance.now() - startedAt;
      await result.deferredBatchWork;
      return returnedMs;
    };

    const deferredMs = await measure(undefined);
    const waitingMs = await measure('0');
    // Logged for the PR description; the assertions are deliberately loose.
    console.info(
      `[abort-hook-deferral] handler return: deferred=${deferredMs.toFixed(1)}ms waiting=${waitingMs.toFixed(1)}ms (hook=${HOOK_MS}ms, pair=${PAIR_MS}ms)`
    );
    expect(waitingMs).toBeGreaterThanOrEqual(HOOK_MS - 5);
    expect(deferredMs).toBeLessThan(HOOK_MS - 40);
  });
});
