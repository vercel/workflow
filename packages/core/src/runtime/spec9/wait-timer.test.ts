import { describe, expect, it, vi } from 'vitest';
import { getWaitContinuationMaxDelaySeconds } from '../wait-continuation.js';
import {
  nearDueTimerIdempotencyKey,
  rearmsCoalescableTimer,
  SENT_NEAR_DUE_TIMER_KEYS_LIMIT,
  sendNearDueTimerOnce,
  waitTimerHopAtMs,
  waitTimerIdempotencyKey,
  waitTimerMessage,
} from './wait-timer.js';

const HOP_MS = getWaitContinuationMaxDelaySeconds() * 1000;

describe('waitTimerHopAtMs', () => {
  const resumeAtMs = 10 * HOP_MS + 12_345;

  it('anchors the hops on the deadline, so every sender in one hop window computes the same one', () => {
    const windowStart = resumeAtMs - 3 * HOP_MS;
    const hop = waitTimerHopAtMs({ resumeAtMs, nowMs: windowStart });
    expect(hop).toBe(resumeAtMs - 2 * HOP_MS);
    for (const nowMs of [windowStart + 1, hop - 1, hop - 1000]) {
      expect(waitTimerHopAtMs({ resumeAtMs, nowMs })).toBe(hop);
    }
    // Past it, the next one.
    expect(waitTimerHopAtMs({ resumeAtMs, nowMs: hop })).toBe(hop + HOP_MS);
    // Within one hop of the deadline, the deadline itself.
    expect(waitTimerHopAtMs({ resumeAtMs, nowMs: resumeAtMs - HOP_MS })).toBe(
      resumeAtMs
    );
  });

  it('sends a hop delivered early the hop after it, not itself again', () => {
    const hop = resumeAtMs - 2 * HOP_MS;
    expect(
      waitTimerHopAtMs({ resumeAtMs, nowMs: hop - 500, afterHopAtMs: hop })
    ).toBe(hop + HOP_MS);
    // And a hop delivered late the one its clock is in.
    expect(
      waitTimerHopAtMs({
        resumeAtMs,
        nowMs: hop + HOP_MS + 1,
        afterHopAtMs: hop,
      })
    ).toBe(resumeAtMs);
  });
});

describe('waitTimerMessage', () => {
  const resumeAtMs = 10 * HOP_MS;
  const base = { correlationId: 'wait_a', resumeAtMs, seconds: 0 };

  it('marks every hop but the last and keys each by its deadline', () => {
    const nowMs = resumeAtMs - 2 * HOP_MS - 30_000;
    const first = waitTimerMessage({ ...base, nowMs });
    expect(first.hopAtMs).toBe(resumeAtMs - 2 * HOP_MS);
    expect(first.delaySeconds).toBe(30);
    expect(first.waitContinuation).toEqual({
      correlationId: 'wait_a',
      attempt: 0,
      resumeAtMs,
      hopAtMs: first.hopAtMs,
    });
    expect(first.idempotencyKey).toBe(
      waitTimerIdempotencyKey({
        correlationId: 'wait_a',
        resumeAtMs,
        hopAtMs: first.hopAtMs,
      })
    );
    const last = waitTimerMessage({
      ...base,
      seconds: 5,
      nowMs: resumeAtMs - 5000,
    });
    expect(last.hopAtMs).toBe(resumeAtMs);
    expect(last.delaySeconds).toBe(5);
    expect(last.waitContinuation).toEqual({
      correlationId: 'wait_a',
      attempt: 0,
    });
  });

  it('never delays a hop past one queue delay', () => {
    const hop = resumeAtMs - HOP_MS;
    const next = waitTimerMessage({
      ...base,
      seconds: Math.ceil((resumeAtMs - (hop - 5000)) / 1000),
      nowMs: hop - 5000,
      afterHopAtMs: hop,
    });
    expect(next.hopAtMs).toBe(resumeAtMs);
    expect(next.delaySeconds).toBe(getWaitContinuationMaxDelaySeconds());
  });

  it("gives a re-arm after an early timer its attempt's key", () => {
    const nowMs = resumeAtMs - 1000;
    const keys = [0, 1, 2].map(
      (attempt) =>
        waitTimerMessage({ ...base, seconds: 1, nowMs, attempt }).idempotencyKey
    );
    expect(new Set(keys).size).toBe(3);
  });

  it('keys a near-due re-arm apart from every hop', () => {
    const nowMs = resumeAtMs - 1000;
    const hop = waitTimerMessage({ ...base, seconds: 1, nowMs });
    expect(
      nearDueTimerIdempotencyKey({ correlationId: 'wait_a', resumeAtMs, nowMs })
    ).not.toBe(hop.idempotencyKey);
    // Even in the second of the deadline.
    expect(
      nearDueTimerIdempotencyKey({
        correlationId: 'wait_a',
        resumeAtMs,
        nowMs: resumeAtMs,
      })
    ).not.toBe(hop.idempotencyKey);
  });
});

describe('rearmsCoalescableTimer', () => {
  it("takes the near-due key only for a last hop from a delivery that may hold one, other than a timer's own re-arm", () => {
    const base = {
      mayHoldCoalescedTimer: true,
      intermediate: false,
      attempt: 0,
    };
    expect(rearmsCoalescableTimer(base)).toBe(true);
    expect(
      rearmsCoalescableTimer({ ...base, mayHoldCoalescedTimer: false })
    ).toBe(false);
    expect(rearmsCoalescableTimer({ ...base, intermediate: true })).toBe(false);
    expect(rearmsCoalescableTimer({ ...base, attempt: 1 })).toBe(false);
  });
});

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
