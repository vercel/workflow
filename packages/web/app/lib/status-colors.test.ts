import { describe, expect, it } from 'vitest';
import { getStatusColorClass } from './status-colors';

describe('getStatusColorClass', () => {
  it.each([
    ['completed', 'bg-geist-cyan'],
    ['failed', 'bg-geist-error'],
    ['running', 'bg-geist-warning'],
    ['pending', 'bg-gray-500'],
    ['cancelled', 'bg-gray-500'],
  ] as const)('maps %s to %s', (status, className) => {
    expect(getStatusColorClass(status)).toBe(className);
  });
});
