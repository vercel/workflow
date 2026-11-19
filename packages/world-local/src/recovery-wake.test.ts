import { expect, it } from 'vitest';
import { MAX_SAFE_TIMEOUT_MS } from './queue.js';
import { backstopWakeDelaySeconds } from './recovery-wake.js';

const now = Date.UTC(2026, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

it('wakes a recovered wait when it is due', () => {
  expect(backstopWakeDelaySeconds(now + 1_500, now)).toBe(2);
  expect(backstopWakeDelaySeconds(now + 7 * DAY_MS, now)).toBe(7 * 86_400);
});

it('wakes an overdue wait at once', () => {
  expect(backstopWakeDelaySeconds(now - 60_000, now)).toBe(0);
});

it("sends no wake for a wait due after the queue's longest timer", () => {
  // `sleep('30d')`: a plain wake would fire early, after ~24.8 days, and
  // re-arm nothing; the recovery delivery arms the wait's hop chain.
  expect(backstopWakeDelaySeconds(now + 30 * DAY_MS, now)).toBeUndefined();
  expect(
    backstopWakeDelaySeconds(now + MAX_SAFE_TIMEOUT_MS + 1, now)
  ).toBeUndefined();
  expect(backstopWakeDelaySeconds(now + MAX_SAFE_TIMEOUT_MS, now)).toBe(
    Math.ceil(MAX_SAFE_TIMEOUT_MS / 1000)
  );
});
