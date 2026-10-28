import { type Event, SPEC_VERSION_CURRENT } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { createVirtualClock } from './clock.js';
import { checkStartHookInvariants } from './start-hook-invariants.js';
import { createSimWorld } from './world.js';

const AT = new Date(1_704_067_200_000);

function event(
  runId: string,
  slot: number,
  eventType: string,
  eventData?: Record<string, unknown>
): Event {
  return {
    runId,
    eventId: `evnt_${String(slot).padStart(26, '0')}`,
    eventType,
    createdAt: AT,
    specVersion: SPEC_VERSION_CURRENT,
    ...(eventData ? { eventData } : {}),
  } as Event;
}

const creation = (token: string) => ({
  deploymentId: 'dpl_sim',
  workflowName: 'wf',
  input: new Uint8Array([1]),
  startHook: { token },
});

describe('starthook.at-most-one-owner', () => {
  it('reads an owner end in commit order, not by its timestamp', () => {
    const world = createSimWorld({
      clock: createVirtualClock(AT.getTime()),
      startHooks: true,
    });
    const first = world.ids.runId();
    const second = world.ids.runId();
    // One millisecond: the second owner is admitted before the first ends.
    world.store.seedFromLog([
      event(first, 1, 'run_created', creation('t')),
      event(first, 2, 'run_started'),
      event(second, 1, 'run_created', creation('t')),
      event(first, 3, 'run_completed', { output: new Uint8Array([2]) }),
    ]);

    const rules = checkStartHookInvariants({
      world,
      requests: [],
      effects: [],
    }).map((v) => v.rule);
    expect(rules).toContain('starthook.at-most-one-owner');
  });

  it('accepts an owner admitted after the previous one ended', () => {
    const world = createSimWorld({
      clock: createVirtualClock(AT.getTime()),
      startHooks: true,
    });
    const first = world.ids.runId();
    const second = world.ids.runId();
    world.store.seedFromLog([
      event(first, 1, 'run_created', creation('t')),
      event(first, 2, 'run_started'),
      event(first, 3, 'run_completed', { output: new Uint8Array([2]) }),
      event(second, 1, 'run_created', creation('t')),
    ]);

    const rules = checkStartHookInvariants({
      world,
      requests: [],
      effects: [],
    }).map((v) => v.rule);
    expect(rules).not.toContain('starthook.at-most-one-owner');
  });

  // An orphan never reaches a log; its decision is placed by commit count.
  function withOrphan(
    committedEvents: number,
    cancelled?: { committedEvents: number; retentionUntilMs?: number }
  ) {
    const world = createSimWorld({
      clock: createVirtualClock(AT.getTime()),
      startHooks: true,
    });
    const first = world.ids.runId();
    const orphan = world.ids.runId();
    const store = world.store;
    const decisions = store.startHookDecisions.bind(store);
    store.startHookDecisions = () => [
      ...decisions(),
      {
        runId: orphan,
        token: 't',
        decision: 'accepted',
        decidedAtMs: AT.getTime(),
        committedEvents,
        ...(cancelled
          ? { cancelled: { atMs: AT.getTime(), ...cancelled } }
          : {}),
      },
    ];
    return { world, first };
  }

  it('accepts a zero-retention owner that ended before an orphan was decided in the same millisecond', () => {
    const { world, first } = withOrphan(3);
    world.store.seedFromLog([
      event(first, 1, 'run_created', {
        ...creation('t'),
        startHook: { token: 't', tokenRetentionUntil: AT },
      }),
      event(first, 2, 'run_started'),
      event(first, 3, 'run_completed', { output: new Uint8Array([2]) }),
    ]);

    const rules = checkStartHookInvariants({
      world,
      requests: [],
      effects: [],
    }).map((v) => v.rule);
    expect(rules).not.toContain('starthook.at-most-one-owner');
  });

  it('flags an owner admitted after an orphan was decided in the same millisecond', () => {
    const { world, first } = withOrphan(0);
    world.store.seedFromLog([event(first, 1, 'run_created', creation('t'))]);

    const violations = checkStartHookInvariants({
      world,
      requests: [],
      effects: [],
    }).filter((v) => v.rule === 'starthook.at-most-one-owner');
    expect(violations.map((v) => v.runId)).toEqual([first]);
  });

  it("frees a cancelled orphan's token once its cancellation committed and its retention passed", () => {
    const { world, first } = withOrphan(0, { committedEvents: 0 });
    world.store.seedFromLog([event(first, 1, 'run_created', creation('t'))]);

    const rules = checkStartHookInvariants({
      world,
      requests: [],
      effects: [],
    }).map((v) => v.rule);
    expect(rules).not.toContain('starthook.at-most-one-owner');
  });

  it("still flags an admission inside a cancelled orphan's retention", () => {
    const { world, first } = withOrphan(0, {
      committedEvents: 0,
      retentionUntilMs: AT.getTime() + 60_000,
    });
    world.store.seedFromLog([event(first, 1, 'run_created', creation('t'))]);

    const violations = checkStartHookInvariants({
      world,
      requests: [],
      effects: [],
    }).filter((v) => v.rule === 'starthook.at-most-one-owner');
    expect(violations.map((v) => v.runId)).toEqual([first]);
  });
});
