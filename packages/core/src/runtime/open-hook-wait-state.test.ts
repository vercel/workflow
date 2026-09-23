import { type Event, SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getOpenWaitClockSkewMs,
  OPEN_WAIT_CLOCK_SKEW_MS,
} from './constants.js';
import {
  hasOpenWaitDueBy,
  openHookAndWaitState,
} from './open-hook-wait-state.js';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const HOUR = 60 * 60 * 1_000;
/**
 * What the runtime passes: the end of the invocation's inline window plus the
 * skew allowance. A 2-minute window (the runtime's fallback when the World
 * reports no deadline) started at NOW.
 */
const INLINE_WINDOW_MS = 2 * 60 * 1_000;
const DEADLINE = NOW + INLINE_WINDOW_MS + OPEN_WAIT_CLOCK_SKEW_MS;

let seq = 0;
function event(
  eventType: Event['eventType'],
  correlationId: string,
  eventData?: unknown
): Event {
  return {
    eventType,
    runId: 'wrun_open_wait_test',
    eventId: `evnt_${String(seq++).padStart(4, '0')}`,
    createdAt: new Date(NOW - HOUR),
    specVersion: SPEC_VERSION_CURRENT,
    correlationId,
    eventData,
  } as Event;
}

const waitCreated = (id: string, resumeAt: unknown) =>
  event('wait_created', id, { resumeAt });
const waitCompleted = (id: string) => event('wait_completed', id, {});
const hookCreated = (id: string) =>
  event('hook_created', id, { token: `tok_${id}` });
const hookDisposed = (id: string) => event('hook_disposed', id, {});

/** The two gate consumers ask exactly this question of the state. */
const gates = (events: Event[], deadlineMs = DEADLINE) =>
  hasOpenWaitDueBy(openHookAndWaitState(events), deadlineMs);

describe('openHookAndWaitState', () => {
  it('reports no open hook or wait for an empty log', () => {
    expect(openHookAndWaitState([])).toEqual({
      openHook: false,
      openWait: false,
      earliestOpenWaitResumeAtMs: undefined,
    });
  });

  it('keeps `openWait` true for any open wait, regardless of its deadline', () => {
    const farFuture = new Date(NOW + 24 * HOUR);
    const state = openHookAndWaitState([waitCreated('wait_1', farFuture)]);
    expect(state.openWait).toBe(true);
    expect(state.earliestOpenWaitResumeAtMs).toBe(farFuture.getTime());
  });

  it('reports the earliest deadline when several waits are open', () => {
    const state = openHookAndWaitState([
      waitCreated('wait_far', new Date(NOW + 24 * HOUR)),
      waitCreated('wait_near', new Date(NOW + 5_000)),
      waitCreated('wait_mid', new Date(NOW + HOUR)),
    ]);
    expect(state.earliestOpenWaitResumeAtMs).toBe(NOW + 5_000);
  });

  it('drops a completed wait from the deadline computation', () => {
    const state = openHookAndWaitState([
      waitCreated('wait_near', new Date(NOW + 5_000)),
      waitCreated('wait_far', new Date(NOW + 24 * HOUR)),
      waitCompleted('wait_near'),
    ]);
    expect(state.openWait).toBe(true);
    expect(state.earliestOpenWaitResumeAtMs).toBe(NOW + 24 * HOUR);
  });

  it('accepts `resumeAt` as an ISO string or epoch number from a raw payload', () => {
    const at = NOW + HOUR;
    expect(
      openHookAndWaitState([waitCreated('w', new Date(at).toISOString())])
        .earliestOpenWaitResumeAtMs
    ).toBe(at);
    expect(
      openHookAndWaitState([waitCreated('w', at)]).earliestOpenWaitResumeAtMs
    ).toBe(at);
  });

  it('marks a wait whose `resumeAt` is missing or unparseable as due now', () => {
    for (const resumeAt of [undefined, null, 'not a date', Number.NaN, {}]) {
      const state = openHookAndWaitState([
        waitCreated('wait_far', new Date(NOW + 24 * HOUR)),
        waitCreated('wait_unknown', resumeAt),
      ]);
      expect(state.openWait).toBe(true);
      expect(state.earliestOpenWaitResumeAtMs).toBe(-Infinity);
    }
  });

  it('tracks hooks independently of waits', () => {
    expect(openHookAndWaitState([hookCreated('h1')]).openHook).toBe(true);
    expect(
      openHookAndWaitState([hookCreated('h1'), hookDisposed('h1')]).openHook
    ).toBe(false);
    expect(
      openHookAndWaitState([hookCreated('h1'), hookDisposed('h1')]).openWait
    ).toBe(false);
    const both = openHookAndWaitState([
      hookCreated('h1'),
      waitCreated('w1', new Date(NOW + 24 * HOUR)),
    ]);
    expect(both.openHook).toBe(true);
    expect(both.openWait).toBe(true);
  });
});

describe('hasOpenWaitDueBy (the inline-delta and turbo gate)', () => {
  it('does not gate on a wait due after the invocation can still be alive', () => {
    expect(gates([waitCreated('w', new Date(NOW + 24 * HOUR))])).toBe(false);
    expect(gates([waitCreated('w', new Date(NOW + HOUR))])).toBe(false);
  });

  it('gates on the same wait once its deadline falls inside the window', () => {
    expect(gates([waitCreated('w', new Date(DEADLINE - 1))])).toBe(true);
    expect(gates([waitCreated('w', new Date(DEADLINE))])).toBe(true);
    expect(gates([waitCreated('w', new Date(DEADLINE + 1))])).toBe(false);
  });

  it('gates on a wait due during the inline window even when it is minutes out', () => {
    // The step body about to run can outlive the wait; the resume that wait
    // spawns must not find this invocation still forcing claims.
    expect(gates([waitCreated('w', new Date(NOW + 45_000))])).toBe(true);
    expect(gates([waitCreated('w', new Date(NOW + INLINE_WINDOW_MS))])).toBe(
      true
    );
  });

  it('follows a longer inline window (a raised WORKFLOW_V2_TIMEOUT_MS)', () => {
    const longWindow = NOW + 3 * HOUR + OPEN_WAIT_CLOCK_SKEW_MS;
    const log = [waitCreated('w', new Date(NOW + HOUR))];
    expect(gates(log, DEADLINE)).toBe(false);
    expect(gates(log, longWindow)).toBe(true);
  });

  it('gates on a wait that is already past its deadline', () => {
    expect(gates([waitCreated('w', new Date(NOW - 1))])).toBe(true);
    expect(gates([waitCreated('w', new Date(NOW - 24 * HOUR))])).toBe(true);
  });

  it('gates on a wait with a missing or unparseable `resumeAt`', () => {
    for (const resumeAt of [undefined, null, 'not a date', Number.NaN]) {
      expect(gates([waitCreated('w', resumeAt)])).toBe(true);
    }
  });

  it('does not gate on a completed wait, whatever its deadline', () => {
    for (const resumeAt of [
      new Date(NOW - HOUR),
      new Date(NOW + 1_000),
      new Date(NOW + 24 * HOUR),
      undefined,
    ]) {
      expect(gates([waitCreated('w', resumeAt), waitCompleted('w')])).toBe(
        false
      );
    }
  });

  it('gates when any one of several open waits is due in the window', () => {
    expect(
      gates([
        waitCreated('far', new Date(NOW + 24 * HOUR)),
        waitCreated('near', new Date(NOW + 1_000)),
      ])
    ).toBe(true);
    expect(
      gates([
        waitCreated('far', new Date(NOW + 24 * HOUR)),
        waitCreated('near', new Date(NOW + 1_000)),
        waitCompleted('near'),
      ])
    ).toBe(false);
  });

  it('re-engages as later invocations start closer to a far wait', () => {
    const log = [waitCreated('w', new Date(NOW + 24 * HOUR))];
    const windowEndFrom = (startMs: number) =>
      startMs + INLINE_WINDOW_MS + OPEN_WAIT_CLOCK_SKEW_MS;
    expect(gates(log, windowEndFrom(NOW))).toBe(false);
    expect(gates(log, windowEndFrom(NOW + 23 * HOUR))).toBe(false);
    expect(
      gates(
        log,
        windowEndFrom(
          NOW + 24 * HOUR - INLINE_WINDOW_MS - OPEN_WAIT_CLOCK_SKEW_MS
        )
      )
    ).toBe(true);
    expect(gates(log, windowEndFrom(NOW + 24 * HOUR + 1))).toBe(true);
  });

  it('ignores hooks: an open hook alone is not a wait, and `openHook` is untouched by waits', () => {
    // Hook gating happens on `openHook` in the runtime and must be unaffected
    // by this predicate in either direction.
    const hookOnly = openHookAndWaitState([hookCreated('h')]);
    expect(hookOnly.openHook).toBe(true);
    expect(hasOpenWaitDueBy(hookOnly, DEADLINE)).toBe(false);

    const hookAndFarWait = openHookAndWaitState([
      hookCreated('h'),
      waitCreated('w', new Date(NOW + 24 * HOUR)),
    ]);
    expect(hookAndFarWait.openHook).toBe(true);
    expect(hasOpenWaitDueBy(hookAndFarWait, DEADLINE)).toBe(false);

    const disposedHookNearWait = openHookAndWaitState([
      hookCreated('h'),
      hookDisposed('h'),
      waitCreated('w', new Date(NOW + 1_000)),
    ]);
    expect(disposedHookNearWait.openHook).toBe(false);
    expect(hasOpenWaitDueBy(disposedHookNearWait, DEADLINE)).toBe(true);
  });

  describe('skew allowance override', () => {
    const original = process.env.WORKFLOW_OPEN_WAIT_CLOCK_SKEW_MS;
    afterEach(() => {
      if (original === undefined) {
        delete process.env.WORKFLOW_OPEN_WAIT_CLOCK_SKEW_MS;
      } else {
        process.env.WORKFLOW_OPEN_WAIT_CLOCK_SKEW_MS = original;
      }
    });

    it('defaults to OPEN_WAIT_CLOCK_SKEW_MS', () => {
      delete process.env.WORKFLOW_OPEN_WAIT_CLOCK_SKEW_MS;
      expect(getOpenWaitClockSkewMs()).toBe(OPEN_WAIT_CLOCK_SKEW_MS);
    });

    it('a very large override restores unconditional gating of open waits', () => {
      process.env.WORKFLOW_OPEN_WAIT_CLOCK_SKEW_MS = String(365 * 24 * HOUR);
      const windowEnd = NOW + INLINE_WINDOW_MS + getOpenWaitClockSkewMs();
      const state = openHookAndWaitState([
        waitCreated('w', new Date(NOW + 24 * HOUR)),
      ]);
      expect(hasOpenWaitDueBy(state, windowEnd)).toBe(true);
    });

    it('rejects a negative override back to zero rather than shrinking the window', () => {
      process.env.WORKFLOW_OPEN_WAIT_CLOCK_SKEW_MS = '-5000';
      expect(getOpenWaitClockSkewMs()).toBe(0);
    });
  });
});
