import {
  type Event,
  ROOT_RUN_ID_ATTRIBUTE,
  SPEC_VERSION_CURRENT,
} from '@workflow/world';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import type { QueueItem } from '../global.js';
import {
  advanceOnlyHasWork,
  advanceOnlyLeavesStep,
  peerStepIds,
  pendingStepIdsIn,
  runRowFromCreation,
  settlesBranch,
  settlesWithin,
  suspensionHasNewWork,
} from './branch-replay.js';
import { runIdCreatedAt } from './run-id-time.js';

const step = (hasCreatedEvent?: boolean): QueueItem => ({
  type: 'step',
  correlationId: 'step_1',
  stepName: 'step',
  args: [],
  hasCreatedEvent,
});

const hook = (fields: Partial<Extract<QueueItem, { type: 'hook' }>>) =>
  ({
    type: 'hook',
    correlationId: 'hook_1',
    token: 'token',
    ...fields,
  }) as QueueItem;

const wait = (hasCreatedEvent?: boolean): QueueItem => ({
  type: 'wait',
  correlationId: 'wait_1',
  resumeAt: new Date(),
  hasCreatedEvent,
});

describe('suspensionHasNewWork', () => {
  it('is false when everything the workflow waits on already exists', () => {
    // The shape a sibling's settlement leaves behind in a `Promise.all` of
    // one-step branches: every other step created, nothing to write.
    expect(
      suspensionHasNewWork({
        items: [
          step(true),
          step(true),
          hook({ hasCreatedEvent: true }),
          wait(true),
        ],
      })
    ).toBe(false);
  });

  it('is true for a step without its creation event', () => {
    // A chain that just advanced: its next step is new.
    expect(suspensionHasNewWork({ items: [step(true), step()] })).toBe(true);
    expect(suspensionHasNewWork({ items: [step(false)] })).toBe(true);
  });

  it('is true for a new hook or wait', () => {
    expect(suspensionHasNewWork({ items: [hook({})] })).toBe(true);
    expect(suspensionHasNewWork({ items: [wait()] })).toBe(true);
  });

  it('is true for a hook disposal or abort not yet recorded', () => {
    expect(
      suspensionHasNewWork({
        items: [hook({ hasCreatedEvent: true, disposed: true })],
      })
    ).toBe(true);
    expect(
      suspensionHasNewWork({
        items: [hook({ hasCreatedEvent: true, abortRequested: true })],
      })
    ).toBe(true);
  });

  it('is true for an attribute write', () => {
    expect(
      suspensionHasNewWork({
        items: [
          step(true),
          { type: 'attribute', correlationId: 'attr_1', changes: [] },
        ],
      })
    ).toBe(true);
  });

  it('is false for an empty suspension', () => {
    expect(suspensionHasNewWork({ items: [] })).toBe(false);
  });
});

describe('advanceOnlyLeavesStep', () => {
  const firstDelivery = { messageId: 'msg_this', redelivery: false };
  const redelivery = { messageId: 'msg_this', redelivery: true };
  const pending = (fields: Record<string, unknown>) =>
    ({
      type: 'step',
      correlationId: 'step_1',
      stepName: 'step',
      args: [],
      hasCreatedEvent: true,
      ...fields,
    }) as Extract<QueueItem, { type: 'step' }>;

  it('leaves a sibling another delivery is running or has sent', () => {
    // Claimed inline elsewhere, started from its own message, or created
    // and sent but not picked up yet.
    const owned = pending({ ownerMessageId: 'msg_other', lastStartedAt: 1 });
    const queued = pending({ lastStartedAt: 1 });
    const unstarted = pending({});
    for (const step of [owned, queued, unstarted]) {
      expect(advanceOnlyLeavesStep(step, firstDelivery)).toBe(true);
    }
    expect(advanceOnlyLeavesStep(owned, redelivery)).toBe(true);
    expect(advanceOnlyLeavesStep(queued, redelivery)).toBe(true);
  });

  it('keeps a step this message claimed, so its redelivery recovers it', () => {
    const mine = pending({ ownerMessageId: 'msg_this', lastStartedAt: 1 });
    expect(advanceOnlyLeavesStep(mine, firstDelivery)).toBe(false);
    expect(advanceOnlyLeavesStep(mine, redelivery)).toBe(false);
  });

  it('keeps a never-started step on a redelivery, which may have created it', () => {
    expect(advanceOnlyLeavesStep(pending({}), redelivery)).toBe(false);
  });

  it('decides whether a suspension leaves the pass anything to do', () => {
    const siblings = { items: [pending({ lastStartedAt: 1 }), pending({})] };
    expect(advanceOnlyHasWork(siblings, firstDelivery)).toBe(false);
    // The never-started one is owed on a redelivery.
    expect(advanceOnlyHasWork(siblings, redelivery)).toBe(true);
    // New work always counts.
    expect(
      advanceOnlyHasWork({ items: [...siblings.items, step()] }, firstDelivery)
    ).toBe(true);
  });
});

describe('settlesBranch', () => {
  it('settles on a completed or failed step', () => {
    expect(settlesBranch({ type: 'completed' })).toBe(true);
    expect(settlesBranch({ type: 'completed', hasPendingOps: false })).toBe(
      true
    );
    expect(settlesBranch({ type: 'failed' })).toBe(true);
  });

  it('holds back a completed step whose stream writes are still flushing', () => {
    expect(settlesBranch({ type: 'completed', hasPendingOps: true })).toBe(
      false
    );
  });

  it('does not settle on outcomes that leave the branch where it was', () => {
    expect(settlesBranch({ type: 'retry', timeoutSeconds: 1 })).toBe(false);
    expect(settlesBranch({ type: 'throttled', timeoutSeconds: 1 })).toBe(false);
    expect(settlesBranch({ type: 'skipped' })).toBe(false);
    expect(settlesBranch({ type: 'gone' })).toBe(false);
  });
});

describe('runRowFromCreation', () => {
  const runId = `wrun_${ulid()}`;
  const input = new Uint8Array([1, 2, 3]);
  const runCreated = (eventData: Record<string, unknown> = {}) =>
    ({
      eventId: 'evnt_1',
      runId,
      createdAt: new Date(),
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_from_event',
        workflowName: 'workflow//./src/flow//flow',
        input,
        executionContext: { workflowVm: 'node' },
        attributes: { team: 'core' },
        ...eventData,
      },
    }) as unknown as Event;
  const runContext = {
    deploymentId: 'dpl_carried',
    specVersion: SPEC_VERSION_CURRENT,
    startedAt: Date.parse('2026-01-02T03:04:05.000Z'),
    rootRunId: runId,
  };

  it('builds a running row from the carried identity and run_created', () => {
    const row = runRowFromCreation(runId, runCreated(), runContext);
    expect(row).toEqual({
      runId,
      status: 'running',
      // The deployment the run is pinned to, from the message.
      deploymentId: 'dpl_carried',
      workflowName: 'workflow//./src/flow//flow',
      specVersion: SPEC_VERSION_CURRENT,
      executionContext: { workflowVm: 'node' },
      input,
      attributes: { team: 'core' },
      startedAt: new Date(runContext.startedAt),
      // The time the run id encodes, which is what seeds the VM clock.
      createdAt: new Date(runIdCreatedAt(runId) as number),
      updatedAt: new Date(runContext.startedAt),
    });
  });

  it('carries the lineage root of a child run', () => {
    const row = runRowFromCreation(runId, runCreated({ attributes: {} }), {
      ...runContext,
      rootRunId: 'wrun_parent',
    });
    expect(row?.attributes).toEqual({
      [ROOT_RUN_ID_ATTRIBUTE]: 'wrun_parent',
    });
  });

  it('keeps the public key the run was created with', () => {
    const row = runRowFromCreation(
      runId,
      runCreated({ encryptionPublicKey: 'cHVibGlj' }),
      runContext
    );
    expect(row?.encryptionPublicKey).toBe('cHVibGlj');
  });

  it('declines a run id that encodes no creation time', () => {
    // The VM clock would then come from the stored row's createdAt, which
    // only a read can supply.
    expect(
      runRowFromCreation('wrun_not_a_ulid', runCreated(), runContext)
    ).toBeUndefined();
  });

  it('declines a message without the run start time', () => {
    const { startedAt: _, ...withoutStart } = runContext;
    expect(
      runRowFromCreation(runId, runCreated(), withoutStart)
    ).toBeUndefined();
  });

  it('declines an event that is not run_created', () => {
    expect(
      runRowFromCreation(
        runId,
        { ...runCreated(), eventType: 'run_started' } as unknown as Event,
        runContext
      )
    ).toBeUndefined();
  });
});

describe('pendingStepIdsIn', () => {
  const event = (eventType: string, correlationId?: string) =>
    ({ eventType, correlationId }) as unknown as Event;

  it('lists steps created or started without a terminal event', () => {
    expect(
      pendingStepIdsIn([
        event('run_created'),
        event('step_created', 'step_a'),
        event('step_created', 'step_b'),
        // Created on its start alone, as a World may record an inline step.
        event('step_started', 'step_c'),
        event('step_completed', 'step_a'),
        event('step_created', 'step_d'),
        event('step_failed', 'step_d'),
      ])
    ).toEqual(new Set(['step_b', 'step_c']));
  });

  it('is empty when every step has settled', () => {
    expect(
      pendingStepIdsIn([
        event('step_created', 'step_a'),
        event('step_completed', 'step_a'),
      ]).size
    ).toBe(0);
  });
});

describe('settlesWithin', () => {
  it('answers true as soon as the promise settles, either way', async () => {
    await expect(settlesWithin(Promise.resolve(), 1000)).resolves.toBe(true);
    await expect(
      settlesWithin(Promise.reject(new Error('x')), 1000)
    ).resolves.toBe(true);
  });

  it('answers false once the time passes', async () => {
    const never = new Promise(() => {});
    const startedAt = Date.now();
    await expect(settlesWithin(never, 30)).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });

  it('answers false at once for no time at all', async () => {
    await expect(settlesWithin(Promise.resolve(), 0)).resolves.toBe(false);
  });
});

describe('peerStepIds', () => {
  const event = (eventType: string, correlationId?: string) =>
    ({ eventType, correlationId }) as unknown as Event;

  it('counts the siblings that existed when the step started', () => {
    const events = [
      // One round: the queued step is written first, the inline sibling is
      // created by its claim just after, and the queued step starts later.
      event('step_created', 'queued'),
      event('step_created', 'inline'),
      event('step_started', 'inline'),
      event('step_started', 'queued'),
      event('step_completed', 'inline'),
      // The inline branch advanced on its own while the queued step ran.
      event('step_started', 'inline_next'),
      event('step_completed', 'queued'),
    ];
    expect(
      peerStepIds(events, new Set(['inline', 'inline_next']), 'queued')
    ).toEqual(new Set(['inline']));
  });

  it('is empty when every pending sibling came after the step started', () => {
    const events = [
      event('step_created', 'slow'),
      event('step_started', 'slow'),
      event('step_started', 'fast_next'),
      event('step_completed', 'slow'),
    ];
    expect(peerStepIds(events, new Set(['fast_next']), 'slow').size).toBe(0);
  });

  it('treats every pending sibling as a peer when the step never started', () => {
    // Nothing to place the reference at, so wait on all of them, the cheap
    // side to err on.
    const events = [event('step_created', 'a'), event('step_created', 'b')];
    expect(peerStepIds(events, new Set(['b']), 'a')).toEqual(new Set(['b']));
  });
});
