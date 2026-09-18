import { describe, expect, it } from 'vitest';
import { Chain } from './chain.js';

describe('workflow Chain handle', () => {
  const revive = (length = 3) =>
    (Chain as any)[Symbol.for('workflow-deserialize')]({
      runId: 'wrun_test',
      stepId: 'step_test',
      slot: 'slot_0',
      length,
    }) as Chain<number>;

  it('carries refs and selects prefixes without Node dependencies', () => {
    const sequence = revive();
    expect(sequence.length).toBe(3);
    expect(sequence.take(1).length).toBe(1);
    expect(sequence.take(3)).toBe(sequence);
  });

  it('rejects step-only operations', () => {
    const sequence = revive();
    expect(() => Chain.from()).toThrow('inside a step');
    expect(() => sequence.append()).toThrow('inside a step');
    expect(() => sequence.get()).toThrow('inside a step');
    expect(() => sequence.toArray()).toThrow('inside a step');
  });
});
