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
  advanceOnlyReplayIdempotencyKey,
  analyzePendingStepsForReplay,
  hasAdvanceOnlyBranchReplayEvidence,
  pendingStepIdsIn,
  runRowFromCreation,
  settlesBranch,
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

const event = (eventType: string, correlationId?: string) =>
  ({ eventType, correlationId }) as unknown as Event;

describe('advanceOnlyReplayIdempotencyKey', () => {
  it('is stable per run and step and distinct across either identity', () => {
    expect(advanceOnlyReplayIdempotencyKey('run-a', 'step-a')).toBe(
      advanceOnlyReplayIdempotencyKey('run-a', 'step-a')
    );
    expect(advanceOnlyReplayIdempotencyKey('run-a', 'step-a')).not.toBe(
      advanceOnlyReplayIdempotencyKey('run-a', 'step-b')
    );
    expect(advanceOnlyReplayIdempotencyKey('run-a', 'step-a')).not.toBe(
      advanceOnlyReplayIdempotencyKey('run-b', 'step-a')
    );
  });
});

describe('hasAdvanceOnlyBranchReplayEvidence', () => {
  it('does not treat a timer winning beside a step as a branch replay', () => {
    expect(
      hasAdvanceOnlyBranchReplayEvidence([
        event('wait_created', 'wait'),
        event('step_created', 'slow'),
        event('step_started', 'slow'),
        event('wait_completed', 'wait'),
      ])
    ).toBe(false);
  });

  it('does not treat a fire-and-forget step alone as a branch replay', () => {
    expect(
      hasAdvanceOnlyBranchReplayEvidence([
        event('step_created', 'detached'),
        event('step_started', 'detached'),
      ])
    ).toBe(false);
  });

  it.each([
    'step_created',
    'hook_created',
    'wait_created',
  ] as const)('recognizes %s after a branch settles beside a pending peer', (createdEventType) => {
    expect(
      hasAdvanceOnlyBranchReplayEvidence([
        event('step_created', 'fast'),
        event('step_started', 'fast'),
        event('step_created', 'slow'),
        event('step_started', 'slow'),
        event('step_completed', 'fast'),
        event(createdEventType, 'downstream'),
      ])
    ).toBe(true);
  });

  it('requires the peer to remain pending until downstream work is created', () => {
    expect(
      hasAdvanceOnlyBranchReplayEvidence([
        event('step_created', 'fast'),
        event('step_started', 'fast'),
        event('step_created', 'slow'),
        event('step_started', 'slow'),
        event('step_completed', 'fast'),
        event('step_completed', 'slow'),
        event('step_created', 'later'),
      ])
    ).toBe(false);
  });

  it('resets after an advancing episode drains before a later timeout race', () => {
    expect(
      hasAdvanceOnlyBranchReplayEvidence([
        event('step_created', 'quick'),
        event('step_started', 'quick'),
        event('step_created', 'slow-episode'),
        event('step_started', 'slow-episode'),
        event('step_completed', 'quick'),
        event('step_created', 'quick-2'),
        event('step_started', 'quick-2'),
        event('step_completed', 'quick-2'),
        event('step_completed', 'slow-episode'),
        event('wait_created', 'timeout'),
        event('step_created', 'slow-timeout'),
        event('step_started', 'slow-timeout'),
        event('wait_completed', 'timeout'),
      ])
    ).toBe(false);
  });

  it('recognizes an early retry starting while its peer remains pending', () => {
    expect(
      hasAdvanceOnlyBranchReplayEvidence([
        event('step_created', 'retry'),
        event('step_started', 'retry'),
        event('step_created', 'slow'),
        event('step_started', 'slow'),
        event('step_retrying', 'retry'),
        event('step_started', 'retry'),
      ])
    ).toBe(true);
  });
});

describe('analyzePendingStepsForReplay', () => {
  it('keeps the attempt-start width after a wide batch drains', () => {
    const events = [
      event('step_created', 'a'),
      event('step_created', 'b'),
      event('step_created', 'c'),
      event('step_started', 'a'),
      event('step_started', 'b'),
      event('step_started', 'c'),
      event('step_completed', 'a'),
      event('step_completed', 'b'),
    ];
    expect(
      analyzePendingStepsForReplay(events, 'c').pendingSiblingCountAtLatestStart
    ).toBe(2);
  });

  it('keeps a late queued start bound to the width it waited behind', () => {
    const events = [
      event('step_created', 'a'),
      event('step_created', 'b'),
      event('step_created', 'c'),
      event('step_created', 'd'),
      event('step_created', 'e'),
      event('step_started', 'a'),
      event('step_completed', 'a'),
      event('step_started', 'b'),
      event('step_completed', 'b'),
      event('step_started', 'e'),
    ];
    expect(
      analyzePendingStepsForReplay(events, 'e').pendingSiblingCountAtLatestStart
    ).toBe(4);
  });

  it('excludes an older started step from the current attempt window', () => {
    const events = [
      event('step_created', 'background'),
      event('step_started', 'background'),
      event('step_created', 'current'),
      event('step_created', 'sibling-a'),
      event('step_created', 'sibling-b'),
      event('step_created', 'sibling-c'),
      event('step_started', 'current'),
    ];
    const analysis = analyzePendingStepsForReplay(events, 'current');
    expect(analysis.pendingStepIds.size).toBe(5);
    expect(analysis.pendingSiblingCountAtLatestStart).toBe(3);
  });

  it('uses a fresh retry window and returns undefined without a new start', () => {
    const events = [
      event('step_created', 'a'),
      event('step_created', 'b'),
      event('step_started', 'a'),
      event('step_started', 'b'),
      event('step_completed', 'b'),
      event('step_retrying', 'a'),
      event('step_started', 'a'),
    ];
    expect(
      analyzePendingStepsForReplay(events, 'a').pendingSiblingCountAtLatestStart
    ).toBe(0);
    events.push(event('step_retrying', 'a'));
    expect(
      analyzePendingStepsForReplay(events, 'a').pendingSiblingCountAtLatestStart
    ).toBeUndefined();
    expect(
      analyzePendingStepsForReplay(events, 'missing')
        .pendingSiblingCountAtLatestStart
    ).toBeUndefined();
  });

  it('keeps same-episode siblings but not older started work in a retry window', () => {
    const events = [
      event('step_created', 'background'),
      event('step_started', 'background'),
      event('step_created', 'current'),
      event('step_created', 'sibling-a'),
      event('step_created', 'sibling-b'),
      event('step_started', 'current'),
      event('step_started', 'sibling-a'),
      event('step_started', 'sibling-b'),
      event('step_retrying', 'current'),
      event('step_started', 'current'),
    ];
    expect(
      analyzePendingStepsForReplay(events, 'current')
        .pendingSiblingCountAtLatestStart
    ).toBe(2);
  });

  it('resets the too-wide decision after an episode reaches zero pending steps', () => {
    const events = [
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => event('step_created', id)),
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
        event('step_completed', id)
      ),
      event('step_created', 'later-a'),
      event('step_created', 'later-b'),
      event('step_started', 'later-a'),
    ];
    const analysis = analyzePendingStepsForReplay(events, 'later-a');
    expect(analysis.currentEpisodePeakPendingStepCount).toBe(2);
    expect(analysis.pendingSiblingCountAtLatestStart).toBe(1);
  });

  it('keeps a wide decision while any step from the episode remains pending', () => {
    const events = [
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => event('step_created', id)),
      ...['a', 'b', 'c', 'd', 'e'].map((id) => event('step_completed', id)),
      event('step_created', 'later-a'),
      event('step_created', 'later-b'),
      event('step_started', 'later-a'),
    ];
    const analysis = analyzePendingStepsForReplay(events, 'later-a');
    expect(analysis.currentEpisodePeakPendingStepCount).toBe(6);
  });
  it('recognizes only creation-only pending rows written after the attempt began', () => {
    const events = [
      event('step_created', 'current'),
      event('step_started', 'current'),
      event('step_created', 'later_a'),
      event('step_created', 'later_b'),
      event('step_failed', 'current'),
      event('step_started', 'current'),
    ];
    expect(
      analyzePendingStepsForReplay(events, 'current')
        .pendingCreationsFollowFirstStart
    ).toBe(true);
  });

  it('rejects pending work that started or predates the current attempt', () => {
    const olderEvents = [
      event('step_created', 'older'),
      event('step_created', 'current'),
      event('step_started', 'current'),
      event('step_completed', 'current'),
    ];
    expect(
      analyzePendingStepsForReplay(olderEvents, 'current')
        .pendingCreationsFollowFirstStart
    ).toBe(false);

    const startedLaterEvents = [
      event('step_created', 'current'),
      event('step_started', 'current'),
      event('step_created', 'started_later'),
      event('step_started', 'started_later'),
      event('step_completed', 'current'),
    ];
    expect(
      analyzePendingStepsForReplay(startedLaterEvents, 'current')
        .pendingCreationsFollowFirstStart
    ).toBe(false);
  });
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
  const firstDelivery = {
    messageId: 'msg_this',
    recoverNeverStarted: false,
  };
  const redelivery = {
    messageId: 'msg_this',
    recoverNeverStarted: true,
  };
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
  const persistedStartedAt = new Date('2026-01-02T03:04:06.000Z');
  const runStarted = () =>
    ({
      eventId: 'evnt_2',
      runId,
      createdAt: persistedStartedAt,
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {},
    }) as unknown as Event;
  const runContext = {
    deploymentId: 'dpl_carried',
    specVersion: SPEC_VERSION_CURRENT,
    startedAt: Date.parse('2026-01-02T03:04:05.000Z'),
    rootRunId: runId,
  };

  it('builds a running row from the carried identity and run_created', () => {
    const row = runRowFromCreation(
      runId,
      runCreated(),
      runStarted(),
      runContext
    );
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
      // The persisted event is canonical even when turbo dispatched a local
      // synthesized timestamp in the message.
      startedAt: persistedStartedAt,
      // The time the run id encodes, which is what seeds the VM clock.
      createdAt: new Date(runIdCreatedAt(runId) as number),
      updatedAt: persistedStartedAt,
    });
  });

  it('uses the same workflowStartedAt as an ordinary stored-row replay', () => {
    const ordinaryReplayRow = { startedAt: persistedStartedAt };
    const advanceOnlyReplayRow = runRowFromCreation(
      runId,
      runCreated(),
      runStarted(),
      runContext
    );
    expect(advanceOnlyReplayRow?.startedAt).toEqual(
      ordinaryReplayRow.startedAt
    );
  });

  it('carries the lineage root of a child run', () => {
    const row = runRowFromCreation(
      runId,
      runCreated({ attributes: {} }),
      runStarted(),
      {
        ...runContext,
        rootRunId: 'wrun_parent',
      }
    );
    expect(row?.attributes).toEqual({
      [ROOT_RUN_ID_ATTRIBUTE]: 'wrun_parent',
    });
  });

  it('keeps the public key the run was created with', () => {
    const row = runRowFromCreation(
      runId,
      runCreated({ encryptionPublicKey: 'cHVibGlj' }),
      runStarted(),
      runContext
    );
    expect(row?.encryptionPublicKey).toBe('cHVibGlj');
  });

  it('declines a run id that encodes no creation time', () => {
    // The VM clock would then come from the stored row's createdAt, which
    // only a read can supply.
    expect(
      runRowFromCreation(
        'wrun_not_a_ulid',
        runCreated(),
        runStarted(),
        runContext
      )
    ).toBeUndefined();
  });

  it('declines a log without run_started', () => {
    expect(
      runRowFromCreation(runId, runCreated(), undefined, runContext)
    ).toBeUndefined();
  });

  it('declines a corrupt run_started timestamp', () => {
    expect(
      runRowFromCreation(
        runId,
        runCreated(),
        { ...runStarted(), createdAt: new Date('invalid') },
        runContext
      )
    ).toBeUndefined();
  });

  it('declines an event that is not run_created', () => {
    expect(
      runRowFromCreation(
        runId,
        { ...runCreated(), eventType: 'run_started' } as unknown as Event,
        runStarted(),
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

  it('ignores replay-derived drain-only creations but counts them once started', () => {
    const created = event('step_created', 'detached');
    const started = event('step_started', 'detached');
    const terminalDrainStepIds = new Set(['detached']);
    expect(pendingStepIdsIn([created], terminalDrainStepIds)).toEqual(
      new Set()
    );
    expect(pendingStepIdsIn([created, started], terminalDrainStepIds)).toEqual(
      new Set(['detached'])
    );
  });
});
