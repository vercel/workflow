import { CorruptedEventLogError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from '../events-consumer.js';
import { WorkflowSuspension } from '../global.js';
import type { WorkflowOrchestratorContext } from '../private.js';
import { createContext } from '../vm/index.js';
import { createSleep } from './sleep.js';

const DEFAULT_FIXED_TIMESTAMP = 1753481739458;

// Helper to setup context to simulate a workflow run
function setupWorkflowContext(
  events: Event[]
): WorkflowOrchestratorContext & { updateTimestamp: (ts: number) => void } {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: DEFAULT_FIXED_TIMESTAMP,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  // The workflow's ULID seed (correlationIds) is derived from the original
  // start time and is stable across replays, even if the wall clock advances.
  const workflowStartedAt = DEFAULT_FIXED_TIMESTAMP;
  const ctx: WorkflowOrchestratorContext = {
    runId: 'wrun_test',
    encryptionKey: undefined,
    globalThis: context.globalThis,
    // ctx.onWorkflowError is accessed via closure — it's defined below on the same object
    eventsConsumer: new EventsConsumer(events, {
      onUnconsumedEvent: (event) => {
        ctx.onWorkflowError(
          new CorruptedEventLogError(
            `Unconsumed event in event log: eventType=${event.eventType}, correlationId=${event.correlationId}, eventId=${event.eventId}. This indicates a corrupted or invalid event log.`
          )
        );
      },
      getPromiseQueue: () => Promise.resolve(),
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: vi.fn(),
    promiseQueue: Promise.resolve(),
    pendingDeliveries: 0,
    pendingDeliveryBarriers: new Map(),
  };
  return Object.assign(ctx, { updateTimestamp: context.updateTimestamp });
}

describe('createSleep', () => {
  it('should resolve when wait_completed event is received', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'wait_completed',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        createdAt: new Date(),
      },
    ]);

    const sleep = createSleep(ctx);
    await sleep('1s');

    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
    expect(ctx.invocationsQueue.size).toBe(0);
  });

  it('should resolve old wait_completed events without eventData', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'wait_completed',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        createdAt: new Date(),
      },
    ]);

    const sleep = createSleep(ctx);
    await sleep('1s');

    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
    expect(ctx.invocationsQueue.size).toBe(0);
  });

  it('should invoke workflow error handler when wait_completed resumeAt mismatches the wait', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'wait_completed',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:02.000Z'),
        },
        createdAt: new Date(),
      },
    ]);

    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const sleep = createSleep(ctx);
    void sleep('1s');

    const workflowError = await errorReceived.promise;
    expect(workflowError).toBeInstanceOf(CorruptedEventLogError);
    expect(workflowError?.message).toContain('wait_completed');
    expect(workflowError?.message).toContain('resumeAt');
    expect(workflowError?.message).toContain('wait_01K11TFZ62YS0YYFDQ3E8B9YCV');
  });

  it('does not flag wait_completed.resumeAt when no wait_created was applied and the replay clock advanced', async () => {
    // Production replay divergence (reused-sleep): a `wait_completed` is
    // consumed by a sleep consumer that never consumed a `wait_created`
    // (hasCreatedEvent=false), so the queue item still holds the value freshly
    // computed by parseDurationToDate(duration) = Date.now() + duration.
    //
    // Because `sleep(<number|string>)` resumeAt is wall-clock-relative and the
    // VM clock advances to each event's createdAt during replay, that fresh
    // value differs from the absolute resumeAt the ORIGINAL run recorded into
    // the event. The recorded resumeAt is the source of truth; the consumer's
    // recomputed value is non-deterministic and must NOT be treated as the
    // expected value. Captured from production: hasCreatedEvent=false with an
    // ~18-42s delta between the recomputed and recorded resumeAt.
    const recordedResumeAt = new Date(DEFAULT_FIXED_TIMESTAMP + 5_000);

    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_completed',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: { resumeAt: recordedResumeAt },
        createdAt: new Date(DEFAULT_FIXED_TIMESTAMP + 5_100),
      },
    ]);

    // Simulate replay drift: the wall clock has advanced 30s by the time the
    // workflow re-invokes sleep(5000), so parseDurationToDate computes a
    // resumeAt 30s ahead of the recorded one (the correlationId ULID seed is
    // unchanged — it derives from the original start time).
    ctx.updateTimestamp(DEFAULT_FIXED_TIMESTAMP + 30_000);

    const sleepError = withResolvers<Error>();
    ctx.onWorkflowError = sleepError.resolve;

    const sleep = createSleep(ctx);
    const slept = sleep(5_000);

    // The bug raises CorruptedEventLogError (and never resolves the sleep);
    // the fix lets the sleep resolve with no error. Race the two terminal
    // outcomes directly — no timing guard — so a regression surfaces as the
    // error branch (or a hang caught by the test timeout), never a flaky race
    // against a fixed grace period.
    const outcome = await Promise.race([
      sleepError.promise.then((err) => ({ kind: 'error' as const, err })),
      slept.then(() => ({ kind: 'resolved' as const })),
    ]);

    if (outcome.kind === 'error') {
      throw new Error(
        `Unexpected workflow error on consistent replay: ${outcome.err.message}`
      );
    }
    expect(outcome.kind).toBe('resolved');
    expect(ctx.invocationsQueue.size).toBe(0);
  });

  it('still flags a mismatched absolute-Date wait_completed.resumeAt without wait_created', async () => {
    // An absolute `sleep(Date)` recomputes the same resumeAt on every replay
    // (it is deterministic), so it remains an authoritative value to validate
    // against even without a recorded `wait_created`. A genuine mismatch must
    // still raise — the no-wait_created skip applies only to non-deterministic
    // duration-based sleeps.
    const expectedResumeAt = new Date(DEFAULT_FIXED_TIMESTAMP + 5_000);
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_completed',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: { resumeAt: new Date(DEFAULT_FIXED_TIMESTAMP + 6_000) },
        createdAt: new Date(DEFAULT_FIXED_TIMESTAMP + 6_100),
      },
    ]);

    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const outcome = await Promise.race([
      errorReceived.promise.then((err) => ({ kind: 'error' as const, err })),
      createSleep(ctx)(expectedResumeAt).then(() => ({
        kind: 'resolved' as const,
      })),
    ]);

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.err).toBeInstanceOf(CorruptedEventLogError);
      expect(outcome.err.message).toContain('resumeAt');
    }
  });

  it('flags an invalid wait_completed.resumeAt even when no wait_created was applied', async () => {
    // Counterpart to the test above: skipping the equality check without a
    // recorded value must NOT also swallow a malformed resumeAt. A non-finite
    // resumeAt is corrupt data regardless of `hasCreatedEvent` — the original
    // run always records a valid parseDurationToDate(...) Date, so a consistent
    // log never carries one. Here there is no `wait_created` (hasCreatedEvent
    // stays false) yet the Invalid Date must still raise.
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_completed',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: { resumeAt: new Date(Number.NaN) },
        createdAt: new Date(DEFAULT_FIXED_TIMESTAMP + 5_100),
      },
    ]);

    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const sleep = createSleep(ctx);
    void sleep(5_000);

    const workflowError = await errorReceived.promise;
    expect(workflowError).toBeInstanceOf(CorruptedEventLogError);
    expect(workflowError?.message).toContain('wait_completed');
    expect(workflowError?.message).toContain('Invalid Date');
    expect(workflowError?.message).toContain('wait_01K11TFZ62YS0YYFDQ3E8B9YCV');
  });

  it('should invoke workflow error handler when wait_completed resumeAt is invalid', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'wait_completed',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date(Number.NaN),
        },
        createdAt: new Date(),
      },
    ]);

    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const sleep = createSleep(ctx);
    void sleep('1s');

    const workflowError = await errorReceived.promise;
    expect(workflowError).toBeInstanceOf(CorruptedEventLogError);
    expect(workflowError?.message).toContain('wait_completed');
    expect(workflowError?.message).toContain('Invalid Date');
  });

  it('should throw WorkflowSuspension when no events are available', async () => {
    const ctx = setupWorkflowContext([]);

    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const sleep = createSleep(ctx);

    // Start the sleep - it will process events asynchronously
    const sleepPromise = sleep('1s');

    const workflowError = await errorReceived.promise;
    expect(workflowError).toBeInstanceOf(WorkflowSuspension);
  });

  it('should invoke workflow error handler with CorruptedEventLogError for unexpected event type', async () => {
    // Simulate a corrupted event log where a sleep/wait receives an unexpected event type
    // (e.g., a step_completed event when expecting wait_created/wait_completed)
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_completed', // Wrong event type for a wait!
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          stepName: 'unexpectedStep',
          result: ['test'],
        },
        createdAt: new Date(),
      },
    ]);

    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const sleep = createSleep(ctx);

    // Start the sleep - it will process events asynchronously
    const sleepPromise = sleep('1s');

    const workflowError = await errorReceived.promise;
    expect(workflowError).toBeInstanceOf(CorruptedEventLogError);
    expect(workflowError?.message).toContain('Unexpected event type for wait');
    expect(workflowError?.message).toContain('wait_01K11TFZ62YS0YYFDQ3E8B9YCV');
    expect(workflowError?.message).toContain('step_completed');
  });

  it('should mark wait as having created event when wait_created is received', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:05.000Z'),
        },
        createdAt: new Date(),
      },
    ]);

    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const sleep = createSleep(ctx);

    // Start the sleep - it will process events asynchronously
    const sleepPromise = sleep('5s');

    const workflowError = await errorReceived.promise;

    // Check that the wait item has been updated with hasCreatedEvent
    const waitItem = ctx.invocationsQueue.get(
      'wait_01K11TFZ62YS0YYFDQ3E8B9YCV'
    );
    expect(waitItem).toBeDefined();
    expect(waitItem?.type).toBe('wait');
    if (waitItem?.type === 'wait') {
      expect(waitItem.hasCreatedEvent).toBe(true);
    }

    // Should suspend since wait_completed is not yet received
    expect(workflowError).toBeInstanceOf(WorkflowSuspension);
  });

  it('should handle hook_received as unexpected event type for wait', async () => {
    // Test with a different unexpected event type to ensure all non-wait events are caught
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_received', // Wrong event type for a wait!
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          token: 'test-token',
          payload: { data: 'test' },
        },
        createdAt: new Date(),
      },
    ]);

    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const sleep = createSleep(ctx);
    const sleepPromise = sleep('1s');

    const workflowError = await errorReceived.promise;
    expect(workflowError).toBeInstanceOf(CorruptedEventLogError);
    expect(workflowError?.message).toContain('Unexpected event type for wait');
    expect(workflowError?.message).toContain('hook_received');
  });

  it('should keep queue item after wait_created (not terminal)', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:05.000Z'),
        },
        createdAt: new Date(),
      },
    ]);

    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const sleep = createSleep(ctx);
    const sleepPromise = sleep('5s');

    const workflowError = await errorReceived.promise;

    // Queue item should still exist (wait_created is not terminal)
    expect(ctx.invocationsQueue.size).toBe(1);
    const waitItem = ctx.invocationsQueue.get(
      'wait_01K11TFZ62YS0YYFDQ3E8B9YCV'
    );
    expect(waitItem).toBeDefined();
    expect(waitItem?.type).toBe('wait');

    // Should suspend since wait_completed is not yet received
    expect(workflowError).toBeInstanceOf(WorkflowSuspension);
  });

  it('should remove queue item when wait_completed (terminal state)', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'wait_completed',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        createdAt: new Date(),
      },
    ]);

    const sleep = createSleep(ctx);

    // Before sleep completes, queue should have the item
    expect(ctx.invocationsQueue.size).toBe(0); // Not added yet

    await sleep('1s');

    // Queue should be empty after completion (terminal state)
    expect(ctx.invocationsQueue.size).toBe(0);
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });

  it('should raise CorruptedEventLogError when duplicate wait_completed events exist in the event log', async () => {
    // When the event log has 2 wait_completed for a single wait_created,
    // the first wait_completed removes the callback (Finished), but the second
    // wait_completed has no consumer. The onUnconsumedEvent callback should
    // trigger a CorruptedEventLogError via onWorkflowError.
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'wait_completed',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_123',
        eventType: 'wait_completed', // Duplicate!
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        createdAt: new Date(),
      },
    ]);

    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const sleep = createSleep(ctx);
    await sleep('1s');

    // The duplicate wait_completed at index 2 is orphaned and triggers the error
    const workflowError = await errorReceived.promise;
    expect(workflowError).toBeInstanceOf(CorruptedEventLogError);
    expect(workflowError?.message).toContain('evnt_2');
  });

  it('should resolve with void when wait_completed', async () => {
    const resumeAt = new Date('2024-01-01T00:00:01.000Z');
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt,
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'wait_completed',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt,
        },
        createdAt: new Date(),
      },
    ]);

    const sleep = createSleep(ctx);
    const result = await sleep('1s');

    // sleep() should resolve with void/undefined
    expect(result).toBeUndefined();
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });
});
