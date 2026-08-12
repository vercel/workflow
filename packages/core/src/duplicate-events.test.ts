import type { Event } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowSuspension } from './global.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import {
  CORR_IDS,
  runWithDiscontinuation,
  setupWorkflowContext,
} from './test-support/orchestrator-context.js';
import { createSleep } from './workflow/sleep.js';

/**
 * Concurrent replays of one run share a single event log and write to it
 * without a currency guard, so a replay working from a stale prefix can commit
 * a second `step_created` / `step_started` / `wait_created` for an entity the
 * log already records one of. Those writes are committed but inert: every
 * replay reads the first event of that class at the same position, so the
 * straggler cannot change what the workflow observes.
 *
 * Before this behavior existed the straggler had no consumer left to claim it
 * (the entity's consumer deregistered when it took the step's result), which
 * surfaced as `ReplayDivergenceError` and, after retries, a terminal
 * `CORRUPTED_EVENT_LOG` on a run whose log was fine.
 *
 * These tests drive the real step and sleep primitives against hand-written
 * logs. The unit-level behavior lives in `events-consumer.test.ts`.
 */

const RESUME_AT = new Date('2099-01-01T00:00:00.000Z');

async function dehydrate(value: unknown) {
  const ops: Promise<unknown>[] = [];
  return await dehydrateStepReturnValue(value, 'wrun_test', undefined, ops);
}

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

function pendingStepNames(ctx: ReturnType<typeof setupWorkflowContext>) {
  return [...ctx.invocationsQueue.values()]
    .filter((i) => i.type === 'step')
    .map((i) => (i.type === 'step' ? i.stepName : undefined));
}

describe('events repeating a class already in the log', () => {
  it('ignores a step_started that lands after the step completed', async () => {
    const result = await dehydrate('a-result');
    const onDuplicateEvent = vi.fn();
    const events = [
      event(0, 'step_created', `step_${CORR_IDS[0]}`, { stepName: 'stepA' }),
      event(1, 'step_started', `step_${CORR_IDS[0]}`, { stepName: 'stepA' }),
      event(2, 'step_completed', `step_${CORR_IDS[0]}`, {
        stepName: 'stepA',
        result,
      }),
      // A concurrent replay that had not yet seen evnt_2 re-invokes stepA.
      event(3, 'step_started', `step_${CORR_IDS[0]}`, { stepName: 'stepA' }),
      event(4, 'step_created', `step_${CORR_IDS[1]}`, { stepName: 'stepB' }),
    ];
    const ctx = setupWorkflowContext(events, { onDuplicateEvent });
    const useStep = createUseStep(ctx);

    const observed: unknown[] = [];
    const { error } = await runWithDiscontinuation(ctx, async () => {
      const stepA = useStep('stepA');
      const stepB = useStep('stepB');
      observed.push(await stepA());
      observed.push(await stepB());
      return 'done';
    });

    // Suspension, not divergence: the run is waiting on stepB.
    expect(WorkflowSuspension.is(error)).toBe(true);
    expect(observed).toEqual(['a-result']);
    expect(pendingStepNames(ctx)).toEqual(['stepB']);
    expect(onDuplicateEvent).toHaveBeenCalledTimes(1);
    expect(onDuplicateEvent).toHaveBeenCalledWith(events[3], 'step_started');
  });

  it('ignores a wait_created that lands after the wait completed', async () => {
    const onDuplicateEvent = vi.fn();
    const events = [
      event(0, 'wait_created', `wait_${CORR_IDS[0]}`, { resumeAt: RESUME_AT }),
      event(1, 'wait_completed', `wait_${CORR_IDS[0]}`, {
        resumeAt: RESUME_AT,
      }),
      // A concurrent replay that had not yet seen evnt_1 re-created the sleep.
      event(2, 'wait_created', `wait_${CORR_IDS[0]}`, { resumeAt: RESUME_AT }),
      event(3, 'step_created', `step_${CORR_IDS[1]}`, {
        stepName: 'afterSleep',
      }),
    ];
    const ctx = setupWorkflowContext(events, { onDuplicateEvent });
    const sleep = createSleep(ctx);
    const useStep = createUseStep(ctx);

    const { error } = await runWithDiscontinuation(ctx, async () => {
      await sleep(RESUME_AT);
      await useStep('afterSleep')();
      return 'done';
    });

    expect(WorkflowSuspension.is(error)).toBe(true);
    expect(pendingStepNames(ctx)).toEqual(['afterSleep']);
    expect(onDuplicateEvent).toHaveBeenCalledTimes(1);
    expect(onDuplicateEvent).toHaveBeenCalledWith(events[2], 'wait_created');
  });

  it('still reports divergence for an event repeating nothing in the log', async () => {
    const result = await dehydrate('a-result');
    const onDuplicateEvent = vi.fn();
    const events = [
      event(0, 'step_created', `step_${CORR_IDS[0]}`, { stepName: 'stepA' }),
      event(1, 'step_started', `step_${CORR_IDS[0]}`, { stepName: 'stepA' }),
      event(2, 'step_completed', `step_${CORR_IDS[0]}`, {
        stepName: 'stepA',
        result,
      }),
      // Belongs to no entity this workflow ever creates: the sleep below mints
      // CORR_IDS[1]. Nothing can consume it, and nothing should suppress it.
      event(3, 'wait_created', 'wait_01JZZZZZZZZZZZZZZZZZZZZZZZ', {
        resumeAt: RESUME_AT,
      }),
    ];
    const ctx = setupWorkflowContext(events, { onDuplicateEvent });
    const sleep = createSleep(ctx);
    const useStep = createUseStep(ctx);

    const { error } = await runWithDiscontinuation(ctx, async () => {
      await useStep('stepA')();
      await sleep(RESUME_AT);
      return 'done';
    });

    expect(WorkflowSuspension.is(error)).toBe(false);
    expect(String(error)).toContain('Unconsumed event in event log');
    expect(onDuplicateEvent).not.toHaveBeenCalled();
  });
});
