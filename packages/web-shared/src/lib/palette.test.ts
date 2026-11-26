import { describe, expect, it } from 'vitest';
import { getSpanColors } from './palette';

describe('getSpanColors', () => {
  it('lets an exceptional state override the resource', () => {
    expect(getSpanColors('step', 'failed')).toBe(
      getSpanColors('run', 'failed')
    );
    expect(getSpanColors('run', 'cancelled')).toBe(
      getSpanColors('step', 'cancelled')
    );
  });

  it('keeps the resource colour for ordinary states', () => {
    expect(getSpanColors('step', 'succeeded')).toBe(getSpanColors('step'));
    expect(getSpanColors('run', 'running')).toBe(getSpanColors('run'));
    expect(getSpanColors('sleep', 'sleeping')).toBe(getSpanColors('sleep'));
  });

  it('draws a pending span and an unknown resource like a hook', () => {
    expect(getSpanColors('run', 'pending')).toBe(getSpanColors('hook'));
    expect(getSpanColors('event')).toBe(getSpanColors('hook'));
  });
});
