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
});
