import { type Event, SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getImminentWaitHorizonMs,
  IMMINENT_WAIT_HORIZON_MS,
} from './constants.js';
import {
  hasImminentOpenWait,
  openHookAndWaitState,
} from './open-hook-wait-state.js';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const HORIZON = IMMINENT_WAIT_HORIZON_MS;
const HOUR = 60 * 60 * 1_000;

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
const gates = (events: Event[], nowMs = NOW) =>
  hasImminentOpenWait(openHookAndWaitState(events), nowMs, HORIZON);

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

describe('hasImminentOpenWait (the inline-delta and turbo gate)', () => {
  it('does not gate on a wait far in the future', () => {
    expect(gates([waitCreated('w', new Date(NOW + 24 * HOUR))])).toBe(false);
  });

  it('gates on the same wait once its deadline is inside the horizon', () => {
    expect(gates([waitCreated('w', new Date(NOW + HORIZON - 1))])).toBe(true);
    expect(gates([waitCreated('w', new Date(NOW + HORIZON))])).toBe(true);
    expect(gates([waitCreated('w', new Date(NOW + HORIZON + 1))])).toBe(false);
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

  it('gates when any one of several open waits is imminent', () => {
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

  it('re-engages as the clock approaches a far wait', () => {
    const log = [waitCreated('w', new Date(NOW + HOUR))];
    expect(gates(log, NOW)).toBe(false);
    expect(gates(log, NOW + HOUR - HORIZON - 1)).toBe(false);
    expect(gates(log, NOW + HOUR - HORIZON)).toBe(true);
    expect(gates(log, NOW + HOUR + 1)).toBe(true);
  });

  it('ignores hooks: an open hook alone is not a wait, and `openHook` is untouched by waits', () => {
    // Hook gating happens on `openHook` in the runtime and must be unaffected
    // by this predicate in either direction.
    const hookOnly = openHookAndWaitState([hookCreated('h')]);
    expect(hookOnly.openHook).toBe(true);
    expect(hasImminentOpenWait(hookOnly, NOW, HORIZON)).toBe(false);

    const hookAndFarWait = openHookAndWaitState([
      hookCreated('h'),
      waitCreated('w', new Date(NOW + 24 * HOUR)),
    ]);
    expect(hookAndFarWait.openHook).toBe(true);
    expect(hasImminentOpenWait(hookAndFarWait, NOW, HORIZON)).toBe(false);

    const disposedHookNearWait = openHookAndWaitState([
      hookCreated('h'),
      hookDisposed('h'),
      waitCreated('w', new Date(NOW + 1_000)),
    ]);
    expect(disposedHookNearWait.openHook).toBe(false);
    expect(hasImminentOpenWait(disposedHookNearWait, NOW, HORIZON)).toBe(true);
  });

  describe('horizon override', () => {
    const original = process.env.WORKFLOW_IMMINENT_WAIT_HORIZON_MS;
    afterEach(() => {
      if (original === undefined) {
        delete process.env.WORKFLOW_IMMINENT_WAIT_HORIZON_MS;
      } else {
        process.env.WORKFLOW_IMMINENT_WAIT_HORIZON_MS = original;
      }
    });

    it('defaults to IMMINENT_WAIT_HORIZON_MS', () => {
      delete process.env.WORKFLOW_IMMINENT_WAIT_HORIZON_MS;
      expect(getImminentWaitHorizonMs()).toBe(IMMINENT_WAIT_HORIZON_MS);
      const state = openHookAndWaitState([
        waitCreated('w', new Date(NOW + IMMINENT_WAIT_HORIZON_MS + 1)),
      ]);
      expect(hasImminentOpenWait(state, NOW)).toBe(false);
    });

    it('a very large override restores unconditional gating of open waits', () => {
      process.env.WORKFLOW_IMMINENT_WAIT_HORIZON_MS = String(365 * 24 * HOUR);
      const state = openHookAndWaitState([
        waitCreated('w', new Date(NOW + 24 * HOUR)),
      ]);
      expect(hasImminentOpenWait(state, NOW)).toBe(true);
    });
  });
});
