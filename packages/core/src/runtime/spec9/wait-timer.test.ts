import { describe, expect, it, vi } from 'vitest';
import {
  nearDueTimerIdempotencyKey,
  SENT_NEAR_DUE_TIMER_KEYS_LIMIT,
  sendNearDueTimerOnce,
} from './wait-timer.js';

describe('nearDueTimerIdempotencyKey', () => {
  const base = { correlationId: 'wait_a', resumeAtMs: 10_000, nowMs: 5_000 };

  it('is one key per wait, deadline and second of the sender', () => {
    const key = nearDueTimerIdempotencyKey(base);
    expect(nearDueTimerIdempotencyKey({ ...base, nowMs: 5_999 })).toBe(key);
    expect(nearDueTimerIdempotencyKey({ ...base, nowMs: 6_000 })).not.toBe(key);
    expect(
      nearDueTimerIdempotencyKey({ ...base, resumeAtMs: 10_001 })
    ).not.toBe(key);
    expect(
      nearDueTimerIdempotencyKey({ ...base, correlationId: 'wait_b' })
    ).not.toBe(key);
  });
});

describe('sendNearDueTimerOnce', () => {
  const uniqueKey = () => `wait:test:${Math.random()}`;

  it('sends a key once per process', async () => {
    const key = uniqueKey();
    const send = vi.fn(async () => {});
    expect(await sendNearDueTimerOnce(key, send)).toBe(true);
    expect(await sendNearDueTimerOnce(key, send)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('forgets a key whose send failed', async () => {
    const key = uniqueKey();
    await expect(
      sendNearDueTimerOnce(key, async () => {
        throw new Error('queue unavailable');
      })
    ).rejects.toThrow('queue unavailable');
    const send = vi.fn(async () => {});
    expect(await sendNearDueTimerOnce(key, send)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('remembers only the newest keys', async () => {
    const first = uniqueKey();
    await sendNearDueTimerOnce(first, async () => {});
    for (let i = 0; i < SENT_NEAR_DUE_TIMER_KEYS_LIMIT; i++) {
      await sendNearDueTimerOnce(uniqueKey(), async () => {});
    }
    const send = vi.fn(async () => {});
    expect(await sendNearDueTimerOnce(first, send)).toBe(true);
  });
});
