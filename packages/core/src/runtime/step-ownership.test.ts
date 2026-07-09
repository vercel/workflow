import type { Event } from '@workflow/world';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepInvocationQueueItem } from '../global.js';
import {
  backstopIdempotencyKey,
  hasPendingStepOwnedByMessage,
  isStepOwnershipActive,
  stepLeaseRemainingSeconds,
} from './step-ownership.js';

const LEASE_ENV = 'WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS';

function makeStep(
  overrides: Partial<StepInvocationQueueItem> = {}
): StepInvocationQueueItem {
  return {
    type: 'step',
    correlationId: 'step_01ABC',
    stepName: 'someStep',
    args: [],
    hasCreatedEvent: true,
    ownerMessageId: 'msg_owner',
    lastStartedAt: 1_000_000,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env[LEASE_ENV];
});

describe('isStepOwnershipActive', () => {
  it('is active for a created step whose latest start is stamped', () => {
    expect(isStepOwnershipActive(makeStep())).toBe(true);
  });

  it('is inactive before step_created is observed', () => {
    expect(isStepOwnershipActive(makeStep({ hasCreatedEvent: false }))).toBe(
      false
    );
  });

  it('is inactive when the latest start was unstamped (bare retry start)', () => {
    expect(isStepOwnershipActive(makeStep({ ownerMessageId: undefined }))).toBe(
      false
    );
  });

  it('is permanently inactive after step_retrying', () => {
    expect(isStepOwnershipActive(makeStep({ sawRetrying: true }))).toBe(false);
  });
});

describe('stepLeaseRemainingSeconds', () => {
  it('returns the remaining lease, rounded up to whole seconds', () => {
    process.env[LEASE_ENV] = '100';
    const step = makeStep({ lastStartedAt: 1_000_000 });
    // 100s lease, 40.5s elapsed → 59.5s remaining → ceil to 60.
    expect(stepLeaseRemainingSeconds(step, 1_040_500)).toBe(60);
  });

  it('returns 0 once the lease has expired', () => {
    process.env[LEASE_ENV] = '100';
    const step = makeStep({ lastStartedAt: 1_000_000 });
    expect(stepLeaseRemainingSeconds(step, 1_100_000)).toBe(0);
    expect(stepLeaseRemainingSeconds(step, 2_000_000)).toBe(0);
  });

  it('returns 0 when the start timestamp is missing (degraded mode)', () => {
    expect(
      stepLeaseRemainingSeconds(makeStep({ lastStartedAt: undefined }), 0)
    ).toBe(0);
  });

  it('clamps to the configured lease under client-behind-server clock skew', () => {
    // lastStartedAt is the server-stamped event createdAt; nowMs is the
    // local clock. A client running behind the server computes a remainder
    // longer than the lease — with the lease at the 900s cap that would be
    // a delaySeconds SQS-backed worlds reject (> 900). The clamp keeps the
    // backstop delay within the queue's per-message maximum.
    process.env[LEASE_ENV] = '900';
    const step = makeStep({ lastStartedAt: 1_000_000 });
    // Local clock 30s behind the server stamp.
    expect(stepLeaseRemainingSeconds(step, 970_000)).toBe(900);
  });
});

describe('backstopIdempotencyKey', () => {
  it('never collides with the step message dedupe key (bare correlationId)', () => {
    // The owner's retry handoff enqueues the step keyed by correlationId
    // with a ~1s backoff; a backstop occupying that key would absorb the
    // retry and stall the run for the full lease.
    const step = makeStep();
    expect(backstopIdempotencyKey(step)).not.toBe(step.correlationId);
  });

  it('is stable across wake replays within one ownership epoch', () => {
    // Every wake that observes the same latest step_started derives the
    // same key, capping fan-out at one pending backstop per epoch.
    expect(backstopIdempotencyKey(makeStep())).toBe(
      backstopIdempotencyKey(makeStep())
    );
  });

  it('changes when owner recovery re-stamps the step', () => {
    const initial = makeStep({ lastStartedAt: 1_000_000 });
    const reStamped = makeStep({ lastStartedAt: 1_030_000 });
    expect(backstopIdempotencyKey(reStamped)).not.toBe(
      backstopIdempotencyKey(initial)
    );
  });

  it('is isolated per correlation ID', () => {
    expect(
      backstopIdempotencyKey(makeStep({ correlationId: 'step_A' }))
    ).not.toBe(backstopIdempotencyKey(makeStep({ correlationId: 'step_B' })));
  });

  it('re-arms through a full owner-recovery cycle despite in-flight key retention', () => {
    // Regression for the refreshed-lease re-arm liveness hole: queues dedupe
    // an idempotency key for the original message's lifetime — world-local
    // retains it while a delivery is IN FLIGHT (queue.ts releases keys only
    // after the delivery loop settles), and Vercel Queues behaves the same.
    // A fixed `${correlationId}:backstop` key therefore cannot create a
    // replacement backstop from within the firing backstop's own handler
    // invocation: the publish dedupes against the in-flight message and is
    // dropped, and once that delivery ends no backstop exists — if the
    // recovered owner then dies with its redelivery budget exhausted, the
    // run wedges until an unrelated external wake.
    //
    // Model the queue exactly like world-local's inflightMessages map and
    // walk the sequence from the review:
    //   initial owner → wake arms backstop → owner recovery re-stamps →
    //   first backstop fires during the refreshed lease → replacement
    //   backstop must be accepted → owner loss → recovery path exists.
    const inflight = new Set<string>();
    const enqueue = (key: string): 'accepted' | 'deduped' => {
      if (inflight.has(key)) return 'deduped';
      inflight.add(key);
      return 'accepted';
    };

    // Epoch 1: owner stamps at T0; a wake replay arms the backstop.
    const epoch1 = makeStep({ lastStartedAt: 1_000_000 });
    expect(enqueue(backstopIdempotencyKey(epoch1))).toBe('accepted');
    // A second wake in the same epoch is deduped (fan-out stays capped).
    expect(enqueue(backstopIdempotencyKey(epoch1))).toBe('deduped');

    // Owner crashes; queue redelivery re-stamps step_started at T1
    // (owner recovery) → new ownership epoch, lease refreshed.
    const epoch2 = makeStep({ lastStartedAt: 1_030_000 });

    // The epoch-1 backstop fires during the refreshed lease. Its handler
    // replays, sees ownership active with time remaining, and re-arms —
    // while its own message is still in flight (key not yet released).
    const rearm = enqueue(backstopIdempotencyKey(epoch2));
    expect(rearm).toBe('accepted');

    // Owner dies for good: the epoch-2 backstop is the recovery path, and
    // it exists. (With the old fixed key, `rearm` above is 'deduped' and
    // nothing remains once the first backstop's delivery settles.)
  });
});

describe('hasPendingStepOwnedByMessage', () => {
  const startEvent = (correlationId: string, ownerMessageId?: string) =>
    ({
      eventType: 'step_started',
      correlationId,
      eventData: {
        stepName: 'someStep',
        ...(ownerMessageId !== undefined ? { ownerMessageId } : {}),
      },
    }) as unknown as Event;
  const retryEvent = (correlationId: string) =>
    ({
      eventType: 'step_retrying',
      correlationId,
      eventData: {},
    }) as unknown as Event;

  it('matches a pending step whose latest start is stamped with the message ID', () => {
    const events = [startEvent('step_A', 'msg_1')];
    expect(
      hasPendingStepOwnedByMessage(events, new Set(['step_A']), 'msg_1')
    ).toBe(true);
    expect(
      hasPendingStepOwnedByMessage(events, new Set(['step_A']), 'msg_2')
    ).toBe(false);
    expect(
      hasPendingStepOwnedByMessage(events, new Set(['step_B']), 'msg_1')
    ).toBe(false);
  });

  it('honors latest-start-wins: a bare start clears, a re-stamp restores', () => {
    const cleared = [startEvent('step_A', 'msg_1'), startEvent('step_A')];
    expect(
      hasPendingStepOwnedByMessage(cleared, new Set(['step_A']), 'msg_1')
    ).toBe(false);

    const restored = [...cleared, startEvent('step_A', 'msg_1')];
    expect(
      hasPendingStepOwnedByMessage(restored, new Set(['step_A']), 'msg_1')
    ).toBe(true);
  });

  it('treats step_retrying as a permanent ownership lapse', () => {
    const events = [
      startEvent('step_A', 'msg_1'),
      retryEvent('step_A'),
      // Even a later stamped start cannot revive ownership: from
      // step_retrying on, the step is queue-owned.
      startEvent('step_A', 'msg_1'),
    ];
    expect(
      hasPendingStepOwnedByMessage(events, new Set(['step_A']), 'msg_1')
    ).toBe(false);
  });
});
