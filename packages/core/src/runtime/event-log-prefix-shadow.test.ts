import { EntityConflictError, RunExpiredError } from '@workflow/errors';
import {
  type Event,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
  SPEC_VERSION_SUPPORTS_SEALED_LOG,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
  slotToEventId,
  type World,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREFIX_SHADOW_BUDGET_BYTES,
  PREFIX_SHADOW_CLAIM_MIN_SLOTS,
  PREFIX_SHADOW_ENTRY_CAP_BYTES,
  PREFIX_SHADOW_IDLE_TTL_MS,
  type PrefixShadowSession,
  PrefixShadowStore,
  prefixShadowSpanAttributes,
  PrefixShadowSession as Session,
} from './event-log-prefix-shadow.js';
import { densePrefixLength } from './helpers.js';

const RUN_ID = 'wrun_01KWDK19V8P92WRNG1MFP1N8CD';
const SEALED = SPEC_VERSION_SUPPORTS_SEALED_LOG;

function slotEvent(
  slot: number,
  eventType: Event['eventType'] = 'step_created',
  extra: Partial<Event> = {}
): Event {
  return {
    eventId: slotToEventId(slot),
    runId: RUN_ID,
    eventType,
    correlationId:
      eventType === 'run_created' || eventType === 'run_started'
        ? undefined
        : `step_${slot}`,
    createdAt: new Date(0),
    ...extra,
  } as Event;
}

/** run_created at 1, run_started at 2, steps after. */
function log(length: number): Event[] {
  const events: Event[] = [];
  for (let slot = 1; slot <= length; slot++) {
    events.push(
      slotEvent(
        slot,
        slot === 1 ? 'run_created' : slot === 2 ? 'run_started' : 'step_created'
      )
    );
  }
  return events;
}

function vercelLikeWorld(): World {
  return { capabilities: { replayEventFrameBytes: true } } as unknown as World;
}

/** Stream `events` through a load the way a World would, `bytes(slot)` each. */
function stream(
  session: PrefixShadowSession,
  events: Event[],
  {
    bytes = () => 100,
    source = 'run_started' as const,
    specVersion = SEALED as number,
    hasMore = false,
    onFrame,
  }: {
    bytes?: (slot: number) => number;
    source?: 'run_started' | 'hook_preload';
    specVersion?: number;
    hasMore?: boolean;
    onFrame?: (slot: number) => void;
  } = {}
) {
  const load = session.beginLoad(source);
  events.forEach((event, i) => {
    onFrame?.(i + 1);
    load.observe(event, { byteLength: bytes(i + 1) });
  });
  return load.finish({ events, run: { specVersion }, hasMore });
}

describe('densePrefixLength', () => {
  it('is the gap-free run from slot 1, order-independent', () => {
    expect(densePrefixLength([slotEvent(3), slotEvent(1), slotEvent(2)])).toBe(
      3
    );
    expect(densePrefixLength([slotEvent(1), slotEvent(2), slotEvent(4)])).toBe(
      2
    );
    expect(densePrefixLength([])).toBe(0);
  });

  it('requires slot 1 rather than inheriting findEventSlotGap exemption', () => {
    // A log read in the window before run_created commits starts at slot 2.
    // findEventSlotGap calls that dense; a prefix recorded from it would
    // claim a first event it never saw (LogPrefixCacheHoleyFill).
    expect(densePrefixLength([slotEvent(2), slotEvent(3)])).toBe(0);
  });

  it('counts a sealed-log noop as occupying its slot', () => {
    expect(
      densePrefixLength([slotEvent(1), slotEvent(2, 'noop'), slotEvent(3)])
    ).toBe(3);
  });

  it('has no answer for a log that is not slot-numbered', () => {
    expect(
      densePrefixLength([
        slotEvent(1),
        { ...slotEvent(2), eventId: 'evnt_01KWDK19V8P92WRNG1MFP1N8CD' },
      ])
    ).toBeUndefined();
  });
});

describe('event-log prefix shadow', () => {
  let store: PrefixShadowStore;
  let now: number;
  const world = vercelLikeWorld();
  const open = () => {
    const session = Session.open(world, RUN_ID, { store, now: () => now });
    if (!session) throw new Error('expected a session');
    return session;
  };

  beforeEach(() => {
    vi.stubEnv('WORKFLOW_EVENT_LOG_PREFIX_SHADOW', '1');
    store = new PrefixShadowStore();
    now = 1_000_000;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('opening a session', () => {
    it('is off by default', () => {
      vi.stubEnv('WORKFLOW_EVENT_LOG_PREFIX_SHADOW', '');
      expect(Session.open(world, RUN_ID, { store })).toBeUndefined();
      vi.stubEnv('WORKFLOW_EVENT_LOG_PREFIX_SHADOW', '0');
      expect(Session.open(world, RUN_ID, { store })).toBeUndefined();
    });

    it('records nothing for a World that does not report frame sizes', () => {
      expect(
        Session.open({ capabilities: {} } as unknown as World, RUN_ID, {
          store,
        })
      ).toBeUndefined();
      expect(
        Session.open({} as unknown as World, RUN_ID, { store })
      ).toBeUndefined();
    });

    it('opens with the flag on and a frame-reporting World', () => {
      vi.stubEnv('WORKFLOW_EVENT_LOG_PREFIX_SHADOW', 'true');
      expect(Session.open(world, RUN_ID, { store })).toBeDefined();
    });
  });

  it('misses on the first invocation, then hits on the next one', () => {
    const first = stream(open(), log(4));
    expect(first).toMatchObject({
      outcome: 'miss',
      wouldClaim: false,
      streamEvents: 4,
      streamBytes: 400,
      wouldSkipBytes: 0,
      denseSlots: 4,
    });
    expect(first.cachedSlots).toBeUndefined();
    expect(store.size).toBe(1);
    expect(store.totalBytes).toBe(400);

    now += 1_000;
    // The next invocation: slots 1..4 were held, 5..6 are the tail.
    const second = stream(open(), log(6), {
      bytes: (slot) => slot * 10,
      onFrame: () => {
        now += 5;
      },
    });
    expect(second).toMatchObject({
      outcome: 'hit',
      cachedSlots: 4,
      cachedBytes: 400,
      entryAgeMs: 1_000,
      streamEvents: 6,
      streamBytes: 210,
      // Only the frames at or below N count, as measured on this stream.
      wouldSkipBytes: 10 + 20 + 30 + 40,
      // Four frames in at 5 ms each; the tail starts one frame later.
      timeToPrefixEndMs: 20,
      timeToFirstTailFrameMs: 25,
      streamDurationMs: 30,
      denseSlots: 6,
      // Four slots and 400 bytes is well under one preload page.
      wouldClaim: false,
    });
  });

  it('would claim only a prefix longer than one preload page', () => {
    stream(open(), log(PREFIX_SHADOW_CLAIM_MIN_SLOTS));
    expect(
      stream(open(), log(PREFIX_SHADOW_CLAIM_MIN_SLOTS + 5))
    ).toMatchObject({ outcome: 'hit', wouldClaim: false });
    // That load refilled at 505 slots, which clears the slot gate.
    expect(
      stream(open(), log(PREFIX_SHADOW_CLAIM_MIN_SLOTS + 6))
    ).toMatchObject({ outcome: 'hit', wouldClaim: true });
  });

  it('would claim a short prefix once its bytes exceed one page', () => {
    stream(open(), log(10), { bytes: () => 30 * 1024 });
    expect(stream(open(), log(11))).toMatchObject({
      outcome: 'hit',
      cachedBytes: 300 * 1024,
      wouldClaim: true,
    });
  });

  it('measures a second preload in the same invocation against what earlier invocations left', () => {
    stream(open(), log(3));
    const session = open();
    // The hook preload, then the run_started fallback after it.
    expect(stream(session, log(5), { source: 'hook_preload' })).toMatchObject({
      outcome: 'hit',
      cachedSlots: 3,
    });
    expect(stream(session, log(6))).toMatchObject({
      outcome: 'hit',
      cachedSlots: 3,
    });
  });

  it('counts a frame a retried request resends once', () => {
    const session = open();
    const load = session.beginLoad('run_started');
    const events = log(3);
    load.observe(events[0], { byteLength: 100 });
    load.observe(events[1], { byteLength: 100 });
    load.observe(events[1], { byteLength: 100 });
    load.observe(events[2], { byteLength: 100 });
    expect(
      load.finish({ events, run: { specVersion: SEALED }, hasMore: false })
    ).toMatchObject({ streamEvents: 3, streamBytes: 300 });
  });

  it('reports a refused claim when the run was raised to another spec version', () => {
    stream(open(), log(4), { specVersion: SEALED });
    expect(
      stream(open(), log(6), {
        specVersion: SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
      })
    ).toMatchObject({ outcome: 'refused_version', wouldSkipBytes: 0 });
    // The refill is at the new version, so the next invocation hits again.
    expect(
      stream(open(), log(7), {
        specVersion: SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
      })
    ).toMatchObject({ outcome: 'hit', cachedSlots: 6 });
  });

  it('never counts a run below the sealed-log spec, and fills nothing for it', () => {
    expect(
      stream(open(), log(4), {
        specVersion: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
      })
    ).toMatchObject({ outcome: 'ineligible_spec', wouldClaim: false });
    expect(store.size).toBe(0);
  });

  it('treats a log that is not slot-numbered as ineligible', () => {
    const events = log(2).map((event, i) => ({
      ...event,
      eventId: `evnt_01KWDK19V8P92WRNG1MFP1N8C${i}`,
    }));
    expect(stream(open(), events)).toMatchObject({
      outcome: 'ineligible_ids',
    });
    expect(store.size).toBe(0);
  });

  it('does not measure events that arrived without frame sizes', () => {
    const session = open();
    const load = session.beginLoad('run_started');
    const events = log(3);
    for (const event of events) load.observe(event, undefined);
    expect(
      load.finish({ events, run: { specVersion: SEALED }, hasMore: false })
    ).toMatchObject({ outcome: 'unmeasured', streamBytes: 0 });
    expect(store.size).toBe(0);
  });

  it('reports a bounded page that stopped short of the prefix as a truncated hit', () => {
    stream(open(), log(6));
    expect(stream(open(), log(4), { hasMore: true })).toMatchObject({
      outcome: 'hit_truncated',
      wouldClaim: false,
      wouldSkipBytes: 400,
    });
  });

  it('flags a bounded page missing a slot below the highest one it carried', () => {
    // hasMore says the page stopped early, but slot 3 is a hole INSIDE it (the
    // page carried 1, 2, 4..6): that is a mismatch, not a truncated hit.
    stream(open(), log(5));
    const holey = log(6).filter((e) => e.eventId !== slotToEventId(3));
    expect(stream(open(), holey, { hasMore: true })).toMatchObject({
      outcome: 'prefix_mismatch',
      wouldSkipBytes: 0,
    });
  });

  it('flags a complete log missing a slot the entry held', () => {
    stream(open(), log(5));
    const holey = log(6).filter((e) => e.eventId !== slotToEventId(3));
    expect(stream(open(), holey)).toMatchObject({
      outcome: 'prefix_mismatch',
      wouldSkipBytes: 0,
    });
  });

  it('flags a different event at slot N than the one the entry recorded', () => {
    stream(open(), log(4));
    const rewritten = log(5);
    rewritten[3] = slotEvent(4, 'wait_created', { correlationId: 'wait_x' });
    expect(stream(open(), rewritten)).toMatchObject({
      outcome: 'anchor_mismatch',
    });
  });

  it('flags an anchor whose type alone changed', () => {
    stream(open(), log(4));
    const rewritten = log(5);
    rewritten[3] = slotEvent(4, 'wait_created', { correlationId: 'step_4' });
    expect(stream(open(), rewritten)).toMatchObject({
      outcome: 'anchor_mismatch',
    });
  });

  it('flags an anchor whose correlation id alone changed', () => {
    stream(open(), log(4));
    const rewritten = log(5);
    rewritten[3] = slotEvent(4, 'step_created', { correlationId: 'step_x' });
    expect(stream(open(), rewritten)).toMatchObject({
      outcome: 'anchor_mismatch',
    });
  });

  it('reads an absent correlation id spelled null or undefined as the same anchor', () => {
    // Slot 2 (run_started) carries no correlation id. One decode path spelling
    // it null must not turn a genuine hit into a false bug alarm.
    stream(open(), log(2));
    const next = log(3);
    next[1] = slotEvent(2, 'run_started', {
      correlationId: null as unknown as undefined,
    });
    expect(stream(open(), next)).toMatchObject({
      outcome: 'hit',
      cachedSlots: 2,
    });
  });

  it("fills at the version run_created carries, not a lagging run's", () => {
    // The turbo first delivery's run is synthesized from the caller's stamp;
    // the server raised run_created to the sealed spec on run_started. The
    // fill must follow the event, so the next preload is not misread as a
    // refused claim.
    const raised = log(4);
    raised[0] = slotEvent(1, 'run_created', { specVersion: SEALED });
    const session = open();
    expect(session.recordLog(raised, SPEC_VERSION_SUPPORTS_SLOT_IDENTITY)).toBe(
      4
    );
    const next = log(5);
    next[0] = slotEvent(1, 'run_created', { specVersion: SEALED });
    expect(
      stream(open(), next, {
        specVersion: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
      })
    ).toMatchObject({ outcome: 'hit', cachedSlots: 4 });
  });

  it('falls back to the run version when the log lacks run_created', () => {
    expect(open().recordLog(log(4).slice(1), SEALED)).toBeUndefined();
    // Dense from slot 1 is required anyway; the fallback only matters for the
    // version check, so check it through a full log without the field.
    expect(open().recordLog(log(4), SEALED)).toBe(4);
  });

  it('fills only a prefix that starts at slot 1 and includes run_started', () => {
    // run_created not visible yet: slot 1 missing, nothing to fill.
    stream(open(), log(4).slice(1));
    expect(store.size).toBe(0);
    // run_started past the dense prefix (a hole at 2).
    stream(
      open(),
      [slotEvent(1, 'run_created'), slotEvent(3, 'run_started')],
      {}
    );
    expect(store.size).toBe(0);
  });

  it('never fills an invocation whose first load lacked run_started', () => {
    // A run_started wedge: the preload streams run_created alone, the run is
    // reset to pending and its run_created may be rewritten while this
    // invocation lives on. When run_started later arrives in a delta, the
    // dense prefix holds it, but slot 1 may be the replaced row
    // (LogPrefixCacheRewriteAfterLoad), so this invocation fills nothing.
    const session = open();
    stream(session, log(1));
    expect(store.size).toBe(0);
    expect(session.recordLog(log(4), SEALED)).toBeUndefined();
    expect(store.size).toBe(0);
    // A later invocation that starts from a started log fills as usual.
    expect(open().recordLog(log(4), SEALED)).toBe(4);
  });

  it('decides first-load eligibility even when the preload was unmeasured', () => {
    const session = open();
    const load = session.beginLoad('run_started');
    const wedged = log(1);
    for (const event of wedged) load.observe(event, undefined);
    expect(
      load.finish({ events: wedged, run: { specVersion: SEALED } })
    ).toMatchObject({ outcome: 'unmeasured' });
    expect(session.recordLog(log(4), SEALED)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("does not let turbo's synthesized empty log decide eligibility", () => {
    const session = open();
    expect(session.recordLog([], SEALED)).toBeUndefined();
    expect(session.recordLog(log(4), SEALED)).toBe(4);
  });

  it('forgets a run whose log records its end', () => {
    stream(open(), log(4));
    expect(store.size).toBe(1);
    const ended = [...log(4), slotEvent(5, 'run_completed')];
    stream(open(), ended);
    expect(store.size).toBe(0);
    expect(stream(open(), log(4)).outcome).toBe('miss');
  });

  it('forgets a run on evict', () => {
    stream(open(), log(4));
    open().evict();
    expect(stream(open(), log(5)).outcome).toBe('miss');
  });

  it('forgets a run on its terminal write, a 410, or a lifecycle 409, not on other 409s', () => {
    const cases: [string, (session: PrefixShadowSession) => void, boolean][] = [
      ['run_completed write', (s) => s.noteWrite('run_completed'), true],
      ['step_created write', (s) => s.noteWrite('step_created'), false],
      [
        '410 on any write',
        (s) =>
          s.noteWriteRefused(
            'step_created',
            new RunExpiredError('expired'),
            false
          ),
        true,
      ],
      [
        '409 on run_started',
        (s) =>
          s.noteWriteRefused(
            'run_started',
            new EntityConflictError('finished'),
            false
          ),
        true,
      ],
      [
        '409 on the lazy resume preload',
        (s) =>
          s.noteWriteRefused(
            'hook_received',
            new EntityConflictError('finished'),
            true
          ),
        true,
      ],
      [
        '409 on wait_completed',
        (s) =>
          s.noteWriteRefused(
            'wait_completed',
            new EntityConflictError('already completed'),
            false
          ),
        false,
      ],
      [
        'transport error on run_started',
        (s) => s.noteWriteRefused('run_started', new Error('reset'), false),
        false,
      ],
    ];
    for (const [name, act, evicts] of cases) {
      store.clear();
      stream(open(), log(4));
      act(open());
      expect({ name, size: store.size }).toEqual({
        name,
        size: evicts ? 0 : 1,
      });
    }
  });

  it('never lets a measurement bug reach the load', () => {
    const load = open().beginLoad('run_started');
    expect(() =>
      load.tryObserve(null as unknown as Event, { byteLength: 1 })
    ).not.toThrow();
    const span = { setAttributes: vi.fn() };
    load.tryConclude({ events: log(2), run: { specVersion: SEALED } }, span);
    // The broken load reports nothing rather than a partial measurement.
    expect(span.setAttributes).not.toHaveBeenCalled();
    expect(open().tryBeginLoad('events_list')).toBeUndefined();
  });

  it('expires an entry idle past the TTL', () => {
    stream(open(), log(4));
    now += PREFIX_SHADOW_IDLE_TTL_MS + 1;
    expect(stream(open(), log(5)).outcome).toBe('expired');
  });

  it('a replay turn fill refreshes the TTL', () => {
    stream(open(), log(4));
    now += PREFIX_SHADOW_IDLE_TTL_MS - 1;
    open().recordLog(log(4), SEALED);
    now += PREFIX_SHADOW_IDLE_TTL_MS - 1;
    expect(stream(open(), log(5)).outcome).toBe('hit');
  });

  it('keeps what a replay turn learned after the preload', () => {
    const session = open();
    stream(session, log(3));
    // The turn's settled log grew by an inline delta the stream never saw:
    // sized by estimate for the budget, never counted as measured bytes.
    expect(session.recordLog(log(8), SEALED)).toBe(8);
    const next = stream(open(), log(9));
    expect(next).toMatchObject({ outcome: 'hit', cachedSlots: 8 });
    expect(next.cachedBytes).toBeGreaterThan(300);
    expect(next.wouldSkipBytes).toBe(800);
  });

  it('does not share entries between Worlds', () => {
    stream(open(), log(4));
    const other = Session.open(vercelLikeWorld(), RUN_ID, {
      store,
      now: () => now,
    });
    if (!other) throw new Error('expected a session');
    expect(stream(other, log(5)).outcome).toBe('miss');
  });

  describe('budget', () => {
    it('does not keep a prefix larger than the per-entry cap', () => {
      stream(open(), log(2), {
        bytes: () => PREFIX_SHADOW_ENTRY_CAP_BYTES / 2 + 1,
      });
      expect(store.size).toBe(0);
      expect(stream(open(), log(3)).outcome).toBe('miss');
    });

    it('evicts least recently used entries past the budget', () => {
      const perRun = PREFIX_SHADOW_ENTRY_CAP_BYTES / 2;
      const runs = Array.from(
        { length: PREFIX_SHADOW_BUDGET_BYTES / perRun + 1 },
        (_, i) => `wrun_${i}`
      );
      for (const runId of runs) {
        const session = Session.open(world, runId, { store, now: () => now });
        if (!session) throw new Error('expected a session');
        stream(session, log(2), { bytes: () => perRun / 2 });
      }
      expect(store.totalBytes).toBeLessThanOrEqual(PREFIX_SHADOW_BUDGET_BYTES);
      expect(store.size).toBe(runs.length - 1);
      const oldest = Session.open(world, runs[0], { store, now: () => now });
      const newest = Session.open(world, runs.at(-1) as string, {
        store,
        now: () => now,
      });
      if (!oldest || !newest) throw new Error('expected sessions');
      expect(stream(oldest, log(3)).outcome).toBe('miss');
      expect(stream(newest, log(3)).outcome).toBe('hit');
    });
  });

  it('span attributes carry sizes and timings only', () => {
    stream(open(), log(4));
    const attributes = prefixShadowSpanAttributes(stream(open(), log(5)));
    expect(attributes).toEqual({
      'workflow.replay.prefix_shadow.outcome': 'hit',
      'workflow.replay.prefix_shadow.would_claim': false,
      'workflow.replay.prefix_shadow.stream_events': 5,
      'workflow.replay.prefix_shadow.stream_bytes': 500,
      'workflow.replay.prefix_shadow.would_skip_bytes': 400,
      'workflow.replay.prefix_shadow.stream_duration_ms': 0,
      'workflow.replay.prefix_shadow.cached_slots': 4,
      'workflow.replay.prefix_shadow.cached_bytes': 400,
      'workflow.replay.prefix_shadow.entry_age_ms': 0,
      'workflow.replay.prefix_shadow.time_to_prefix_end_ms': 0,
      'workflow.replay.prefix_shadow.time_to_first_tail_frame_ms': 0,
      'workflow.replay.prefix_shadow.dense_slots': 5,
    });
  });
});
