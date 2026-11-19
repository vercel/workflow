import { describe, expect, it, vi } from 'vitest';
import { main } from './cli.js';
import { parseMinAgeMinutes } from './in-cluster.js';

describe('workflow-postgres-prune', () => {
  it.each([
    ['--service', 'billing'],
    ['--context', 'prod'],
    ['--namespace', 'apps'],
    ['--version', 'abc'],
  ])('refuses %s with --in-cluster instead of ignoring it', async (flag, value) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['--in-cluster', flag, value])).toBe(2);
      expect(error.mock.calls[0]?.[0]).toContain(`--${flag.slice(2)}`);
    } finally {
      error.mockRestore();
    }
  });
});

describe('parseMinAgeMinutes', () => {
  it.each([
    ['60', 60],
    ['0', 0],
    ['1.5', 1.5],
  ])('accepts %s', (value, minutes) => {
    expect(parseMinAgeMinutes(value)).toBe(minutes);
  });

  // NaN would make every worker old enough to delete.
  it.each(['1h', '', ' ', '-5', 'Infinity'])('refuses %j', (value) => {
    expect(() => parseMinAgeMinutes(value)).toThrow(/non-negative number/);
  });
});
