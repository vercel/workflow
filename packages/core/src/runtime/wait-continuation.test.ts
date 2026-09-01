import { afterEach, describe, expect, it } from 'vitest';
import {
  getWaitContinuationDispatch,
  NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS,
  WAIT_CONTINUATION_MAX_DELAY_SECONDS,
} from './wait-continuation.js';

const CORR_ID = 'wait_01ABC';
const NOW = new Date('2026-05-19T12:00:20.500Z').getTime();

describe('getWaitContinuationDispatch', () => {
  describe('mid-range waits', () => {
    it('keeps the delay and prefixes the key with the correlationId', () => {
      const { delaySeconds, idempotencyKey } = getWaitContinuationDispatch(
        60,
        CORR_ID,
        NOW
      );
      expect(delaySeconds).toBe(60);
      expect(idempotencyKey.startsWith(`${CORR_ID}:`)).toBe(true);
    });

    it('PROBE: does NOT dedupe across suspension passes', () => {
      const pass1 = getWaitContinuationDispatch(60, CORR_ID, NOW);
      const pass2 = getWaitContinuationDispatch(45, CORR_ID, NOW + 15_000);
      expect(pass2.idempotencyKey).not.toBe(pass1.idempotencyKey);
    });

    it('covers the full band up to the max delay', () => {
      const low = getWaitContinuationDispatch(
        NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS + 1,
        CORR_ID,
        NOW
      );
      const high = getWaitContinuationDispatch(
        WAIT_CONTINUATION_MAX_DELAY_SECONDS,
        CORR_ID,
        NOW
      );
      expect(low.idempotencyKey.startsWith(`${CORR_ID}:`)).toBe(true);
      expect(high.delaySeconds).toBe(WAIT_CONTINUATION_MAX_DELAY_SECONDS);
      expect(high.idempotencyKey.startsWith(`${CORR_ID}:`)).toBe(true);
    });
  });

  describe('near-elapsed waits', () => {
    it('keeps the full remaining time as the delay', () => {
      const { delaySeconds, idempotencyKey } = getWaitContinuationDispatch(
        NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS,
        CORR_ID,
        NOW
      );
      expect(delaySeconds).toBe(NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS);
      expect(idempotencyKey.startsWith(`${CORR_ID}:`)).toBe(true);
    });

    it('PROBE: does NOT collapse same-second duplicates', () => {
      const first = getWaitContinuationDispatch(1, CORR_ID, NOW);
      const sameSecond = getWaitContinuationDispatch(1, CORR_ID, NOW + 400);
      const retry = getWaitContinuationDispatch(1, CORR_ID, NOW + 1000);
      expect(sameSecond.idempotencyKey).not.toBe(first.idempotencyKey);
      expect(retry.idempotencyKey).not.toBe(first.idempotencyKey);
    });
  });

  describe('waits beyond the max delay (chained hops)', () => {
    const SEVEN_DAYS = 7 * 24 * 3600; // 604800s > 7 * MAX_DELAY (579600s)

    it('clamps the delay to the max and retains the hop index in the key', () => {
      const { delaySeconds, idempotencyKey } = getWaitContinuationDispatch(
        SEVEN_DAYS,
        CORR_ID,
        NOW
      );
      expect(delaySeconds).toBe(WAIT_CONTINUATION_MAX_DELAY_SECONDS);
      expect(idempotencyKey.startsWith(`${CORR_ID}:hop-8:`)).toBe(true);
    });

    it('PROBE: does NOT dedupe re-observations within one hop window', () => {
      const pass1 = getWaitContinuationDispatch(SEVEN_DAYS, CORR_ID, NOW);
      const pass2 = getWaitContinuationDispatch(
        SEVEN_DAYS - 3600,
        CORR_ID,
        NOW + 3600_000
      );
      expect(pass2.idempotencyKey).not.toBe(pass1.idempotencyKey);
    });

    it('produces a fresh key at each hop delivery so the chain advances', () => {
      let remaining = SEVEN_DAYS;
      const keys: string[] = [];
      while (remaining > NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS) {
        const { delaySeconds, idempotencyKey } = getWaitContinuationDispatch(
          remaining,
          CORR_ID,
          NOW + (SEVEN_DAYS - remaining) * 1000
        );
        keys.push(idempotencyKey);
        expect(delaySeconds).toBeLessThanOrEqual(
          WAIT_CONTINUATION_MAX_DELAY_SECONDS
        );
        remaining -= delaySeconds;
      }
      // Every hop must be enqueueable: no key may repeat, or the world's
      // dedupe window would silently drop the next hop and stall the run.
      expect(new Set(keys).size).toBe(keys.length);
      // 604800s chains as 7 max-delay hops + 1 remainder hop.
      expect(keys).toHaveLength(8);
      expect(keys[keys.length - 1]?.startsWith(`${CORR_ID}:`)).toBe(true);
    });

    it('uses a fresh key when the final partial hop lands in the near-elapsed band', () => {
      // Remaining drops below the near-elapsed threshold only at the very
      // end; the second-bucketed key never collides with hop keys.
      const nearEnd = getWaitContinuationDispatch(
        NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS,
        CORR_ID,
        NOW + SEVEN_DAYS * 1000
      );
      expect(nearEnd.idempotencyKey.startsWith(`${CORR_ID}:`)).toBe(true);
    });
  });

  describe('early delivery re-arms under a fresh key', () => {
    it('keys attempt 0 exactly as before attempts existed', () => {
      // The ordinary path must not move: arm once, deliver once, complete.
      // Every branch keeps its old key at attempt 0.
      expect(getWaitContinuationDispatch(60, CORR_ID, NOW, 0)).toEqual(
        getWaitContinuationDispatch(60, CORR_ID, NOW)
      );
      expect(getWaitContinuationDispatch(1, CORR_ID, NOW, 0)).toEqual(
        getWaitContinuationDispatch(1, CORR_ID, NOW)
      );
      const hops = WAIT_CONTINUATION_MAX_DELAY_SECONDS * 2;
      expect(getWaitContinuationDispatch(hops, CORR_ID, NOW, 0)).toEqual(
        getWaitContinuationDispatch(hops, CORR_ID, NOW)
      );
    });

    it('gives a mid-range wait a key it can actually re-arm with', () => {
      // The bug this closes. A mid-range wait keys on the bare correlationId,
      // so a continuation delivered before its deadline spends the only key
      // the wait will ever have: the re-arm is dropped by the dedupe window,
      // nothing else is scheduled to wake the run, and unlike a step there is
      // no ownership backstop to catch it. The run sleeps forever.
      const armed = getWaitContinuationDispatch(60, CORR_ID, NOW);
      const reArmed = getWaitContinuationDispatch(59, CORR_ID, NOW + 1_000, 1);
      expect(armed.idempotencyKey).toBe(CORR_ID);
      expect(reArmed.idempotencyKey).not.toBe(armed.idempotencyKey);
    });

    it('advances on every further early delivery', () => {
      // An early delivery can repeat, so the keys have to keep moving rather
      // than alternate between two values.
      const keys = [0, 1, 2, 3].map(
        (attempt) =>
          getWaitContinuationDispatch(60, CORR_ID, NOW, attempt).idempotencyKey
      );
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('still collapses re-observations within one attempt', () => {
      // The reason the bare key existed: while a wait is pending, every
      // suspension pass re-observes it, and each extra message is a spurious
      // replay plus a reset of the delivery-attempt runaway guard. Passes
      // within one attempt must still dedupe to a single message.
      const first = getWaitContinuationDispatch(60, CORR_ID, NOW, 2);
      const secondPass = getWaitContinuationDispatch(60, CORR_ID, NOW + 250, 2);
      expect(secondPass.idempotencyKey).toBe(first.idempotencyKey);
    });

    it('keeps attempts distinct per wait', () => {
      const a = getWaitContinuationDispatch(60, 'wait_A', NOW, 1);
      const b = getWaitContinuationDispatch(60, 'wait_B', NOW, 1);
      expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    });

    it('does not change the delay, only the key', () => {
      // An early delivery means the deadline has NOT moved, so the re-arm must
      // still wait out the remaining time rather than fire immediately.
      for (const timeout of [1, 60, WAIT_CONTINUATION_MAX_DELAY_SECONDS * 2]) {
        expect(
          getWaitContinuationDispatch(timeout, CORR_ID, NOW, 3).delaySeconds
        ).toBe(getWaitContinuationDispatch(timeout, CORR_ID, NOW).delaySeconds);
      }
    });

    it('composes with the hop suffix on a chained wait', () => {
      const chained = WAIT_CONTINUATION_MAX_DELAY_SECONDS * 2;
      const base = getWaitContinuationDispatch(chained, CORR_ID, NOW);
      const reArmed = getWaitContinuationDispatch(chained, CORR_ID, NOW, 1);
      expect(base.idempotencyKey).toContain('hop-');
      expect(reArmed.idempotencyKey).toContain('hop-');
      expect(reArmed.idempotencyKey).not.toBe(base.idempotencyKey);
    });
  });

  describe('max-delay override caps the near-elapsed threshold', () => {
    const MAX_DELAY_ENV = 'WORKFLOW_WAIT_CONTINUATION_MAX_DELAY_SECONDS';

    afterEach(() => {
      delete process.env[MAX_DELAY_ENV];
    });

    it('never dispatches a delay above a max override set below the threshold', () => {
      // Regression: the near-elapsed branch returned the full remaining time as
      // the delay before the max was applied. With a max below the near-elapsed
      // threshold, a wait in that band was dispatched with a delay above the
      // max. The threshold is now capped at the max so every branch stays
      // within it.
      const overriddenMax = 1;
      expect(overriddenMax).toBeLessThan(NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS);
      process.env[MAX_DELAY_ENV] = String(overriddenMax);

      // A wait exactly at the default near-elapsed threshold would previously
      // return its full (> max) remaining time as the delay.
      const { delaySeconds } = getWaitContinuationDispatch(
        NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS,
        CORR_ID,
        NOW
      );
      expect(delaySeconds).toBeLessThanOrEqual(overriddenMax);
    });
  });
});
