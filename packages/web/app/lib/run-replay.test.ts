import { describe, expect, it } from 'vitest';
import { getRunReplayDisabledReason } from './run-replay';

describe('getRunReplayDisabledReason', () => {
  it('disables Replay until the full run identity loads', () => {
    expect(getRunReplayDisabledReason(undefined, true)).toBe(
      'Loading run identity...'
    );
  });

  it('fails closed when the full run could not be loaded', () => {
    expect(getRunReplayDisabledReason(undefined, false)).toBe(
      'Unable to verify whether this run can be replayed.'
    );
  });

  it('disables dynamic runs and preserves terminal static Replay', () => {
    expect(
      getRunReplayDisabledReason(
        { executionContext: { dynamicWorkflow: { sourceHash: 'hash' } } },
        false
      )
    ).toBe('Dynamic runs cannot be replayed as a new run.');
    expect(
      getRunReplayDisabledReason({ executionContext: {} }, false)
    ).toBeUndefined();
  });
});
