import { FatalError } from '@workflow/errors';
import type { Event, EventOfType } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowSuspension } from '../global.js';
import {
  CORR_IDS,
  runWithDiscontinuation,
  setupWorkflowContext,
} from '../test-support/orchestrator-context.js';
import { createSetAttributes } from './attribute-dispatcher.js';
import { createSleep } from './sleep.js';

function attributeData(bytes: number, allowReservedAttributes: boolean) {
  const eventData = {
    changes: Array.from({ length: 15 }, (_, i) => ({
      key: `k${i}`.padEnd(240, 'k'),
      value: '',
    })),
    writer: { type: 'workflow' as const },
    ...(allowReservedAttributes ? { allowReservedAttributes: true } : {}),
  };
  eventData.changes[0].value = 'x'.repeat(
    bytes - Buffer.byteLength(JSON.stringify(eventData))
  );
  return eventData;
}

describe.each([
  false,
  true,
])('attribute dispatch (reserved flag %s)', (allowReservedAttributes) => {
  const options = { allowReservedAttributes };

  it('suspends to persist an event exactly at the byte limit', async () => {
    const ctx = setupWorkflowContext([]);
    const setAttributes = createSetAttributes(ctx);
    const { error } = await runWithDiscontinuation(ctx, () =>
      setAttributes(
        attributeData(4096, allowReservedAttributes).changes,
        options
      )
    );
    expect(WorkflowSuspension.is(error)).toBe(true);
    expect(ctx.invocationsQueue.size).toBe(1);
  });

  it('rejects an oversized new write catchably without leaving a pending event', async () => {
    const ctx = setupWorkflowContext([]);
    const setAttributes = createSetAttributes(ctx);
    let caught: unknown;
    const { result, error } = await runWithDiscontinuation(ctx, async () => {
      try {
        await setAttributes(
          attributeData(4097, allowReservedAttributes).changes,
          options
        );
      } catch (cause) {
        caught = cause;
      }
      return 'continued';
    });
    expect(caught).toBeInstanceOf(FatalError);
    expect((caught as Error).message).toMatch(/4096.*4097.*Split/);
    expect(error).toBeUndefined();
    expect(result).toBe('continued');
    expect(ctx.invocationsQueue.size).toBe(0);
  });

  it('replays an oversized event persisted before write validation was added', async () => {
    const eventData = attributeData(4097, allowReservedAttributes);
    const event: EventOfType<'attr_set'> = {
      eventType: 'attr_set',
      eventId: 'evnt_0',
      runId: 'wrun_test',
      correlationId: `attr_${CORR_IDS[0]}`,
      createdAt: new Date(),
      eventData,
    };
    const ctx = setupWorkflowContext([event]);
    const setAttributes = createSetAttributes(ctx);
    const { error } = await runWithDiscontinuation(ctx, () =>
      setAttributes(eventData.changes, options)
    );
    expect(error).toBeUndefined();
    expect(ctx.invocationsQueue.size).toBe(0);
    expect(ctx.eventsConsumer.strandedEvent).toBeUndefined();
  });

  it('replays a caught rejection before a recorded wait without diverging', async () => {
    const resumeAt = new Date('2099-01-01T00:00:00.000Z');
    const history = ['wait_created', 'wait_completed'].map((eventType, i) => ({
      eventType,
      eventId: `evnt_${i}`,
      runId: 'wrun_test',
      correlationId: `wait_${CORR_IDS[1]}`,
      createdAt: new Date(),
      eventData: { resumeAt },
    })) as Event[];
    const ctx = setupWorkflowContext(history);
    const setAttributes = createSetAttributes(ctx);
    const sleep = createSleep(ctx);
    const { result, error } = await runWithDiscontinuation(ctx, async () => {
      await setAttributes(
        attributeData(4097, allowReservedAttributes).changes,
        options
      ).catch(() => {});
      await sleep(resumeAt);
      return 'continued';
    });
    expect(error).toBeUndefined();
    expect(result).toBe('continued');
    expect(ctx.eventsConsumer.strandedEvent).toBeUndefined();
  });

  it('does not consume a log slot when rejecting before a retained resume', async () => {
    const ctx = setupWorkflowContext([]);
    const setAttributes = createSetAttributes(ctx);
    const changes = [{ key: 'phase', value: 'recovered' }];
    let continued = false;
    const { error } = await runWithDiscontinuation(ctx, async () => {
      await setAttributes(
        attributeData(4097, allowReservedAttributes).changes,
        options
      ).catch(() => {});
      await setAttributes(changes);
      continued = true;
    });
    expect(WorkflowSuspension.is(error)).toBe(true);
    expect(ctx.eventsConsumer.eventIndex).toBe(0);
    ctx.eventsConsumer.append([
      {
        eventType: 'attr_set',
        eventId: 'evnt_0',
        runId: 'wrun_test',
        correlationId: `attr_${CORR_IDS[1]}`,
        createdAt: new Date(),
        eventData: { changes, writer: { type: 'workflow' } },
      },
    ]);
    await vi.waitFor(() => expect(continued).toBe(true));
    expect(ctx.invocationsQueue.size).toBe(0);
  });
});
