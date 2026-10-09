import { afterEach, describe, expect, it, vi } from 'vitest';
import { invocationAffinity } from './invocation.js';
import {
  affinityForMarker,
  forgetRunAffinity,
  freshRunAffinity,
  noteOwnerAffinity,
  ownerAffinity,
  recordRunAffinity,
  singleOwnerMarker,
} from './run-affinity.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('run affinity', () => {
  it("records a single-owner run's placement and defaults to the run ID", () => {
    recordRunAffinity('wrun_a', '{"vercelAffinity":"cell-3"}', 'dpl_a');
    recordRunAffinity('wrun_b', undefined, 'dpl_a');
    recordRunAffinity('wrun_c', '{}', 'dpl_a');
    expect(freshRunAffinity('wrun_a')).toBe('cell-3.dpl_a');
    expect(freshRunAffinity('wrun_b')).toBe('wrun_b');
    expect(freshRunAffinity('wrun_c')).toBe('wrun_c');
    forgetRunAffinity('wrun_a');
    expect(freshRunAffinity('wrun_a')).toBeUndefined();
  });

  it('does not reuse a mapping past its freshness window', () => {
    vi.useFakeTimers();
    recordRunAffinity('wrun_c', '{"vercelAffinity":"cell-0"}', 'dpl_a');
    vi.advanceTimersByTime(61_000);
    expect(freshRunAffinity('wrun_c')).toBeUndefined();
  });

  it('remembers the affinity an owner was invoked under', () => {
    noteOwnerAffinity('wrun_d', 'cell-1.dpl_a');
    expect(ownerAffinity('wrun_d')).toBe('cell-1.dpl_a');
    // The owner labels and routes its own run with it when it has no
    // fresher mapping.
    expect(invocationAffinity('wrun_d')).toBe('cell-1.dpl_a');
  });

  it('reads the marker from run attributes', () => {
    expect(
      singleOwnerMarker({ $experimentalSingleOwner: '{}', team: 'a' })
    ).toBe('{}');
    expect(singleOwnerMarker({ team: 'a' })).toBeUndefined();
    expect(singleOwnerMarker(undefined)).toBeUndefined();
  });
});

describe('placement', () => {
  it('scopes a shared affinity by the run deployment', () => {
    expect(
      affinityForMarker('wrun_1', '{"vercelAffinity":"cell-0"}', 'dpl_a')
    ).toBe('cell-0.dpl_a');
    expect(
      affinityForMarker('wrun_2', '{"vercelAffinity":"cell-0"}', 'dpl_b')
    ).toBe('cell-0.dpl_b');
  });

  it('routes a run by itself when its marker names no affinity, or names the run', () => {
    for (const marker of [
      '{}',
      '{"vercelAffinity":""}',
      '{"vercelAffinity":"wrun_1"}',
      'not json',
    ])
      expect(affinityForMarker('wrun_1', marker, 'dpl_a')).toBe('wrun_1');
  });
});
