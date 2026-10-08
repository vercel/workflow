import { describe, expect, it } from 'vitest';
import { getEventColor } from './event-colors';

describe('getEventColor', () => {
  it('uses a neutral palette for run cancellations', () => {
    expect(getEventColor('run_cancelled')).toEqual({
      color: 'var(--ds-gray-700)',
      background: 'var(--ds-gray-100)',
      border: 'var(--ds-gray-500)',
      text: 'var(--ds-gray-900)',
      secondary: 'var(--ds-gray-700)',
    });
  });
});
