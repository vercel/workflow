import { afterEach, describe, expect, it } from 'vitest';
import {
  getWaitContinuationDispatch,
  NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS,
  WAIT_CONTINUATION_MAX_DELAY_SECONDS,
} from './wait-continuation.js';

const CORR_ID = 'wait_01ABC';
const NOW = new Date('2026-05-19T12:00:20.500Z').getTime();

describe('getWaitContinuationDispatch', () => {
  describe('mid-range waits (bare correlationId key)', () => {
    it('uses the bare correlationId so re-observations dedupe', () => {
      expect(getWaitContinuationDispatch(60, CORR_ID, NOW)).toEqual({
        delaySeconds: 60,
        idempotencyKey: CORR_ID,
      });
    });

    it('is stable across suspension passes targeting the same deadline', () => {
      const pass1 = getWaitContinuationDispatch(60, CORR_ID, NOW);
      const pass2 = getWaitContinuationDispatch(45, CORR_ID, NOW + 15_000);
      expect(pass2.idempotencyKey).toBe(pass1.idempotencyKey);
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
      expect(low.idempotencyKey).toBe(CORR_ID);
      expect(high).toEqual({
        delaySeconds: WAIT_CONTINUATION_MAX_DELAY_SECONDS,
        idempotencyKey: CORR_ID,
      });
    });
  });

  describe('near-elapsed waits (second-bucketed key)', () => {
    it('suffixes the key with the current epoch second', () => {
      expect(
        getWaitContinuationDispatch(
          NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS,
          CORR_ID,
          NOW
        )
      ).toEqual({
        delaySeconds: NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS,
        idempotencyKey: `${CORR_ID}:${Math.floor(NOW / 1000)}`,
      });
    });

    it('collapses same-second duplicates but frees the key for a later retry', () => {
      const first = getWaitContinuationDispatch(1, CORR_ID, NOW);
      const sameSecond = getWaitContinuationDispatch(1, CORR_ID, NOW + 400);
      // A retry can only be enqueued after the >= 1s delay of the first
      // message, which guarantees a later epoch-second bucket.
      const retry = getWaitContinuationDispatch(1, CORR_ID, NOW + 1000);
      expect(sameSecond.idempotencyKey).toBe(first.idempotencyKey);
      expect(retry.idempotencyKey).not.toBe(first.idempotencyKey);
    });
  });

  describe('waits beyond the max delay (chained hops)', () => {
    const SEVEN_DAYS = 7 * 24 * 3600; // 604800s > 7 * MAX_DELAY (579600s)

    it('clamps the delay to the max and suffixes the key with the hop index', () => {
      expect(getWaitContinuationDispatch(SEVEN_DAYS, CORR_ID, NOW)).toEqual({
        delaySeconds: WAIT_CONTINUATION_MAX_DELAY_SECONDS,
        idempotencyKey: `${CORR_ID}:hop-8`,
      });
    });

    it('keeps the key stable for re-observations within the same hop window', () => {
      const pass1 = getWaitContinuationDispatch(SEVEN_DAYS, CORR_ID, NOW);
      const pass2 = getWaitContinuationDispatch(
        SEVEN_DAYS - 3600,
        CORR_ID,
        NOW + 3600_000
      );
      expect(pass2.idempotencyKey).toBe(pass1.idempotencyKey);
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
      expect(keys[keys.length - 1]).toBe(CORR_ID);
    });

    it('uses a fresh key when the final partial hop lands in the near-elapsed band', () => {
      // Remaining drops below the near-elapsed threshold only at the very
      // end; the second-bucketed key never collides with hop keys.
      const nearEnd = getWaitContinuationDispatch(
        NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS,
        CORR_ID,
        NOW + SEVEN_DAYS * 1000
      );
      expect(nearEnd.idempotencyKey).toMatch(new RegExp(`^${CORR_ID}:\\d+$`));
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
