import { SchedulesApiError } from '@vercel/schedules';
import { describe, expect, it, vi } from 'vitest';
import {
  createScheduledWakes,
  SCHEDULED_WAKE_NAMESPACE,
  scheduleAtString,
  scheduledWakeMinute,
  scheduledWakeName,
} from './scheduled-wakes.js';

const at = (iso: string) => new Date(iso);

describe('scheduledWakeMinute', () => {
  it('fires at most two minutes early and never after wakeAt', () => {
    const now = +at('2026-10-01T12:00:00Z');
    for (let offset = 0; offset < 60_000; offset += 7_000) {
      const wakeAt = new Date(+at('2026-10-01T12:30:00Z') + offset);
      const minute = scheduledWakeMinute(wakeAt, now);
      expect(minute.getUTCSeconds()).toBe(0);
      // Positive jitter of up to 60 s still lands at or before wakeAt.
      expect(+minute + 60_000).toBeLessThanOrEqual(+wakeAt);
      expect(+wakeAt - +minute).toBeLessThan(120_000);
    }
  });

  it('uses the next minute when the early minute has already started', () => {
    const now = +at('2026-10-01T12:00:20Z');
    expect(scheduledWakeMinute(at('2026-10-01T12:00:50Z'), now)).toEqual(
      at('2026-10-01T12:01:00Z')
    );
    expect(scheduledWakeMinute(at('2026-10-01T12:02:30Z'), now)).toEqual(
      at('2026-10-01T12:01:00Z')
    );
  });
});

describe('createScheduledWakes', () => {
  it('creates a one-time schedule on the given topic', async () => {
    const create = vi.fn().mockResolvedValue({});
    const wakes = createScheduledWakes({ create });
    const wakeAt = new Date(Date.now() + 10 * 60_000);
    await wakes.schedule({
      idempotencyKey: 'retained-wait:wrun_A:wait_B',
      wakeAt,
      topic: '__wkf_workflow_x',
      payload: { payload: { runId: 'wrun_A' } },
    });
    expect(create).toHaveBeenCalledWith({
      name: 'retained-wait-wrun_A-wait_B',
      namespace: SCHEDULED_WAKE_NAMESPACE,
      target: { topic: '__wkf_workflow_x' },
      expression: {
        type: 'single',
        at: scheduleAtString(scheduledWakeMinute(wakeAt)),
      },
      payload: { payload: { runId: 'wrun_A' } },
    });
  });

  it('treats an existing schedule as scheduled', async () => {
    const wakes = createScheduledWakes({
      create: vi.fn().mockRejectedValue(new SchedulesApiError(409, 'exists')),
    });
    await expect(
      wakes.schedule({
        idempotencyKey: 'k',
        wakeAt: new Date(Date.now() + 600_000),
        topic: 't',
        payload: {},
      })
    ).resolves.toBeUndefined();
  });

  it('surfaces other failures', async () => {
    const wakes = createScheduledWakes({
      create: vi.fn().mockRejectedValue(new SchedulesApiError(403, 'no')),
    });
    await expect(
      wakes.schedule({
        idempotencyKey: 'k',
        wakeAt: new Date(Date.now() + 600_000),
        topic: 't',
        payload: {},
      })
    ).rejects.toThrow('no');
  });
});

it('derives valid schedule names', () => {
  expect(scheduledWakeName('retained-wait:wrun_A:wait_B')).toBe(
    'retained-wait-wrun_A-wait_B'
  );
  expect(scheduledWakeName(':x')).toBe('w-x');
});
