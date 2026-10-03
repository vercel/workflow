import { afterEach, describe, expect, it, vi } from 'vitest';
import { invocationAffinity } from './invocation.js';
import {
  affinityCellSize,
  forgetRunAffinity,
  freshRunAffinity,
  noteOwnerAffinity,
  ownerAffinity,
  recordRunAffinity,
} from './run-affinity.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('run affinity', () => {
  it('records server-reported cells and defaults to the run ID', () => {
    recordRunAffinity('wrun_a', 'cell-iad1-abc123-3');
    recordRunAffinity('wrun_b', undefined);
    expect(freshRunAffinity('wrun_a')).toBe('cell-iad1-abc123-3');
    expect(freshRunAffinity('wrun_b')).toBe('wrun_b');
    forgetRunAffinity('wrun_a');
    expect(freshRunAffinity('wrun_a')).toBeUndefined();
  });

  it('does not reuse a mapping past its freshness window', () => {
    vi.useFakeTimers();
    recordRunAffinity('wrun_c', 'cell-iad1-abc123-0');
    vi.advanceTimersByTime(61_000);
    expect(freshRunAffinity('wrun_c')).toBeUndefined();
  });

  it('remembers the affinity an owner was invoked under', () => {
    noteOwnerAffinity('wrun_d', 'cell-iad1-abc123-1');
    expect(ownerAffinity('wrun_d')).toBe('cell-iad1-abc123-1');
    // The owner labels and routes its own run with it when it has no
    // fresher server mapping.
    expect(invocationAffinity('wrun_d')).toBe('cell-iad1-abc123-1');
  });

  it('reads the requested cell size from the environment', () => {
    vi.stubEnv('WORKFLOW_AFFINITY_CELL_SIZE', '10');
    expect(affinityCellSize()).toBe(10);
    for (const value of ['', '0', '1.5', '1001', 'ten']) {
      vi.stubEnv('WORKFLOW_AFFINITY_CELL_SIZE', value);
      expect(affinityCellSize()).toBeUndefined();
    }
  });
});
