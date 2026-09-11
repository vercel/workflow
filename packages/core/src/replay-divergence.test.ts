import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import type { QueueItem } from './global.js';
import { WorkflowSuspension } from './global.js';
import {
  describeDivergenceContext,
  findPendingItemAtOrdinal,
} from './replay-divergence.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import {
  CORR_IDS,
  runWithDiscontinuation,
  setupWorkflowContext,
} from './test-support/orchestrator-context.js';

/**
 * A replay that draws the same ordinal for a different kind of entity than
 * the log recorded there leaves an event nobody can consume. The message the
 * runtime raises for that names the pending invocation that holds the
 * ordinal, because that is what says which branch of the workflow the replay
 * took differently. In the production incident this was written for, the log
 * held a `wait_created` where the replay was waiting on a step.
 */

const RESUME_AT = new Date('2099-01-01T00:00:00.000Z');

function event(
  index: number,
  eventType: string,
  correlationId: string,
  eventData: Record<string, unknown>
): Event {
  return {
    eventId: `evnt_${index}`,
    runId: 'wrun_test',
    eventType,
    correlationId,
    eventData,
    createdAt: new Date(),
  } as unknown as Event;
}

async function dehydrate(value: unknown) {
  const ops: Promise<unknown>[] = [];
  return await dehydrateStepReturnValue(value, 'wrun_test', undefined, ops);
}

describe('findPendingItemAtOrdinal', () => {
  const queue = new Map<string, QueueItem>([
    [
      `step_${CORR_IDS[0]}`,
      {
        type: 'step',
        correlationId: `step_${CORR_IDS[0]}`,
        stepName: 'a',
        args: [],
      },
    ],
    [
      `hook_${CORR_IDS[1]}`,
      { type: 'hook', correlationId: `hook_${CORR_IDS[1]}`, token: 't' },
    ],
  ]);

  it('finds an exact correlation id', () => {
    expect(findPendingItemAtOrdinal(queue, `step_${CORR_IDS[0]}`)?.type).toBe(
      'step'
    );
  });

  it('finds a different kind of entity holding the same ULID body', () => {
    expect(findPendingItemAtOrdinal(queue, `wait_${CORR_IDS[0]}`)?.type).toBe(
      'step'
    );
    expect(findPendingItemAtOrdinal(queue, `step_${CORR_IDS[1]}`)?.type).toBe(
      'hook'
    );
  });

  it('returns undefined when nothing holds the ordinal', () => {
    expect(
      findPendingItemAtOrdinal(queue, `wait_${CORR_IDS[2]}`)
    ).toBeUndefined();
    expect(findPendingItemAtOrdinal(queue, 'no-prefix')).toBeUndefined();
  });
});

describe('describeDivergenceContext', () => {
  it('reports the consumer walk position and last consumed event', () => {
    const events = [
      event(0, 'run_started', undefined as unknown as string, {}),
      event(1, 'wait_created', `wait_${CORR_IDS[0]}`, { resumeAt: RESUME_AT }),
    ];
    const consumer = new EventsConsumer(events, {
      onUnconsumedEvent: () => {},
      getPromiseQueue: () => Promise.resolve(),
      isDeliveryIdle: () => true,
    });
    const before = describeDivergenceContext(events[1], new Map(), consumer);
    expect(before).toBe(
      'pending at this id: none. consumer: index=0, length=2, parked=0, lastConsumed=none'
    );
  });
});

describe('unconsumable event message', () => {
  it('names the step holding the ordinal of an unconsumable wait_created', async () => {
    const result = await dehydrate('launched');
    // Log written by a replay that reached a sleep at the second draw; this
    // replay reaches a step there instead.
    const events = [
      event(0, 'step_created', `step_${CORR_IDS[0]}`, { stepName: 'launch' }),
      event(1, 'step_started', `step_${CORR_IDS[0]}`, { stepName: 'launch' }),
      event(2, 'step_completed', `step_${CORR_IDS[0]}`, {
        stepName: 'launch',
        result,
      }),
      event(3, 'wait_created', `wait_${CORR_IDS[1]}`, { resumeAt: RESUME_AT }),
    ];
    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);

    const { error } = await runWithDiscontinuation(ctx, async () => {
      await useStep('launch')();
      await useStep('drainStep')();
      return 'done';
    });

    expect(WorkflowSuspension.is(error)).toBe(false);
    const message = String(error);
    expect(message).toContain(
      `eventType=wait_created, correlationId=wait_${CORR_IDS[1]}, eventId=evnt_3`
    );
    expect(message).toContain(
      `pending at this id: step drainStep (step_${CORR_IDS[1]})`
    );
    expect(message).toContain(
      'consumer: index=3, length=4, parked=0, lastConsumed=evnt_2'
    );
  });

  it('says none when nothing pending holds the ordinal', async () => {
    const events = [
      event(0, 'wait_created', 'wait_01JZZZZZZZZZZZZZZZZZZZZZZZ', {
        resumeAt: RESUME_AT,
      }),
    ];
    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);

    const { error } = await runWithDiscontinuation(ctx, async () => {
      await useStep('launch')();
      return 'done';
    });

    expect(String(error)).toContain('pending at this id: none.');
  });
});
