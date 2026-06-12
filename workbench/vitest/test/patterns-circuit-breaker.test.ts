// TODO(skipped): fail-open default when the coordinator is unreachable —
// sendBreakerEvent auto-starts the coordinator on the first check, so an
// "unreachable coordinator" can't be arranged from outside without waiting
// out the 10s CHECK_TIMEOUT against a deliberately broken world.
//
// The open→half-open transition is NOT skipped: instead of force-waking the
// real 30s cooldown timer child (its run isn't reachable from the test), we
// start our own breakerCooldownTimer(key, 1ms, timerId=1) — byte-for-byte
// the same workflow the coordinator spawns — which delivers the same
// { type: 'timer', timerId: 1 } message and matches the current timerSeq.
import { afterAll, describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import {
  breakerFailures,
  breakerInterleaved,
  breakerSingleCall,
  cancelCoordinator,
} from '../workflows/drivers/circuit-breaker-drivers.js';
import { breakerCooldownTimer } from '../workflows/patterns/circuit-breaker.js';

// FAILURE_THRESHOLD in the canonical file.
const THRESHOLD = 5;

// The local world persists across vitest invocations — coordinators from a
// previous run can still be alive. Unique keys per run keep tests hermetic.
const RUN = `${Date.now().toString(36)}`;
const KEYS = {
  trip: `cb-trip-${RUN}`,
  interleaved: `cb-interleaved-${RUN}`,
  recover: `cb-recover-${RUN}`,
};

describe('circuit-breaker', () => {
  afterAll(async () => {
    for (const key of Object.values(KEYS)) {
      await cancelCoordinator(`circuit-breaker:${key}`);
    }
  });

  it('trips open after FAILURE_THRESHOLD consecutive failures and rejects without running fn', async () => {
    const run = await start(breakerFailures, [KEYS.trip, THRESHOLD + 1]);
    const result = await run.returnValue;

    // First 5 calls ran and failed; the 6th was rejected instantly.
    expect(result.outcomes).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'open',
    ]);
    // fn ran for the 5 failures but NOT for the rejected call.
    expect(result.calls).toEqual([
      'fail-0',
      'fail-1',
      'fail-2',
      'fail-3',
      'fail-4',
    ]);
  });

  it('a success resets the consecutive-failure count', async () => {
    const run = await start(breakerInterleaved, [KEYS.interleaved]);
    const result = await run.returnValue;

    // 8 failures total, but never 5 consecutive — the breaker never trips.
    expect(result.outcomes).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
      'ok',
      'failed',
      'failed',
      'failed',
      'failed',
      'ok',
    ]);
    expect(result.calls).toContain('ok-mid');
    expect(result.calls).toContain('final');
  });

  it('recovers via half-open probe after the cooldown timer fires', async () => {
    // Trip the breaker: 5 consecutive failures (timerSeq becomes 1).
    const trip = await start(breakerFailures, [KEYS.recover, THRESHOLD]);
    const tripResult = await trip.returnValue;
    expect(tripResult.outcomes).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
    ]);

    // While open: instant rejection, fn does not run.
    const blocked = await start(breakerSingleCall, [
      KEYS.recover,
      'blocked',
      false,
    ]);
    const blockedResult = await blocked.returnValue;
    expect(blockedResult.outcome).toBe('open');
    expect(blockedResult.calls).not.toContain('blocked');

    // Deliver the cooldown message without waiting 30s (see file header).
    const timer = await start(breakerCooldownTimer, [KEYS.recover, 1, 1]);
    await timer.returnValue;

    // Half-open: the probe is allowed; its success closes the circuit.
    const probe = await start(breakerSingleCall, [
      KEYS.recover,
      'probe',
      false,
    ]);
    const probeResult = await probe.returnValue;
    expect(probeResult.outcome).toBe('ok');
    expect(probeResult.calls).toContain('probe');

    // Closed again: subsequent calls flow normally.
    const after = await start(breakerSingleCall, [
      KEYS.recover,
      'after',
      false,
    ]);
    const afterResult = await after.returnValue;
    expect(afterResult.outcome).toBe('ok');
    expect(afterResult.calls).toContain('after');
  });
});
