import { describe, expect, it } from 'vitest';
import { getStatusColorClass } from './status-colors';

describe('getStatusColorClass', () => {
  it.each([
    ['completed', 'bg-teal-700'],
    ['failed', 'bg-red-700'],
    ['running', 'bg-blue-700'],
    ['pending', 'bg-gray-700'],
    ['cancelled', 'bg-gray-700'],
  ] as const)('maps %s to %s', (status, className) => {
    expect(getStatusColorClass(status)).toBe(className);
  });
});
