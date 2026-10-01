import { SchedulesApiError, SchedulesClient } from '@vercel/schedules';

/**
 * Timer wakes on Vercel Schedules.
 *
 * One-time schedules have minute granularity and fire up to a minute late
 * (positive jitter). A wake is therefore scheduled at
 * `floorToMinute(wakeAt - 60 s)`, so it arrives no later than `wakeAt` and at
 * most two minutes early; the receiving owner times the remainder itself.
 * Scheduler load may still delay a firing, which only lengthens the sleep.
 * Schedules are not deleted when a sleep completes: a late firing is a no-op
 * wake, and fired one-time schedules are garbage-collected.
 */

export const SCHEDULED_WAKE_NAMESPACE = 'workflow-wake';
/** Idempotency-key prefix of a retained owner's sleep wake (core runtime). */
export const RETAINED_SLEEP_WAKE_PREFIX = 'retained-wait:';
const JITTER_MS = 60_000;
const MINUTE_MS = 60_000;

export function scheduledWakesEnabled(): boolean {
  return process.env.WORKFLOW_SCHEDULED_WAKES === '1';
}

/** Earliest-safe firing minute for a wake due at `wakeAt`, never in the past. */
export function scheduledWakeMinute(wakeAt: Date, now = Date.now()): Date {
  const floored = Math.floor((+wakeAt - JITTER_MS) / MINUTE_MS) * MINUTE_MS;
  // A minute that has already started may be rejected or skipped; the next
  // one is the earliest firing the scheduler can honour.
  const earliest = Math.ceil((now + 1) / MINUTE_MS) * MINUTE_MS;
  return new Date(Math.max(floored, earliest));
}

/** `YYYY-MM-DDTHH:mm` in UTC, the one-time schedule format. */
export function scheduleAtString(at: Date): string {
  return at.toISOString().slice(0, 16);
}

/** Schedule names allow letters, digits and `. _ -`, starting alphanumeric. */
export function scheduledWakeName(idempotencyKey: string): string {
  const name = idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '-');
  return /^[A-Za-z0-9]/.test(name) ? name : `w${name}`;
}

export interface ScheduledWakes {
  schedule(input: {
    idempotencyKey: string;
    wakeAt: Date;
    topic: string;
    payload: unknown;
  }): Promise<void>;
}

export function createScheduledWakes(
  client: Pick<SchedulesClient, 'create'> = new SchedulesClient()
): ScheduledWakes {
  return {
    async schedule({ idempotencyKey, wakeAt, topic, payload }) {
      try {
        await client.create({
          name: scheduledWakeName(idempotencyKey),
          namespace: SCHEDULED_WAKE_NAMESPACE,
          target: { topic },
          expression: {
            type: 'single',
            at: scheduleAtString(scheduledWakeMinute(wakeAt)),
          },
          payload,
        });
      } catch (error) {
        // The same wake (same key, same resumeAt) is already scheduled.
        if (error instanceof SchedulesApiError && error.status === 409) return;
        throw error;
      }
    },
  };
}
