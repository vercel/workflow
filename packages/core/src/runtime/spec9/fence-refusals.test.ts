import { describe, expect, it } from 'vitest';
import {
  clearFenceRefusals,
  noteFenceRefusal,
  REPEATED_FENCE_REFUSAL_WARN_THRESHOLD,
  warnsOnFenceRefusal,
} from './fence-refusals.js';

describe('fence refusal streaks', () => {
  it('counts consecutive refusals per run until a delivery finishes without one', () => {
    const runId = `wrun_fr_${Math.random().toString(36).slice(2)}`;
    expect(noteFenceRefusal(runId)).toBe(1);
    expect(noteFenceRefusal(runId)).toBe(2);
    expect(noteFenceRefusal(`${runId}_other`)).toBe(1);
    clearFenceRefusals(runId);
    expect(noteFenceRefusal(runId)).toBe(1);
  });

  it('warns at the threshold and then at powers of two', () => {
    const warned = Array.from({ length: 70 }, (_, i) => i + 1).filter(
      warnsOnFenceRefusal
    );
    expect(warned[0]).toBe(REPEATED_FENCE_REFUSAL_WARN_THRESHOLD);
    for (const count of warned.slice(1)) {
      expect(count & (count - 1)).toBe(0);
      expect(count).toBeGreaterThan(REPEATED_FENCE_REFUSAL_WARN_THRESHOLD);
    }
    expect(warnsOnFenceRefusal(REPEATED_FENCE_REFUSAL_WARN_THRESHOLD - 1)).toBe(
      false
    );
  });
});
