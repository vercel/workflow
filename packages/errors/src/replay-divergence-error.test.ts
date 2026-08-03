import { describe, expect, test } from 'vitest';
import { ReplayDivergenceError, WorkflowRuntimeError } from './index.js';

describe('ReplayDivergenceError', () => {
  test('is a retryable replay signal with its own documentation link', () => {
    const err = new ReplayDivergenceError('consumer mismatch', {
      eventId: 'event-1',
    });

    expect(err.name).toBe('ReplayDivergenceError');
    expect(err).toBeInstanceOf(WorkflowRuntimeError);
    expect(err.eventId).toBe('event-1');
    expect(err.message).toContain('replay-divergence');
    expect(ReplayDivergenceError.is(err)).toBe(true);
  });

  test('does not treat an error without an event id as replay divergence', () => {
    const err = new WorkflowRuntimeError('not a replay signal');
    err.name = 'ReplayDivergenceError';

    expect(ReplayDivergenceError.is(err)).toBe(false);
  });
});
