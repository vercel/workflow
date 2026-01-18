import { describe, expect, test } from 'vitest';
import { pluralize } from './pluralize.js';

describe('pluralize', () => {
  test('returns singular form when count is 1', () => {
    expect(pluralize('step', 'steps', 1)).toBe('step');
    expect(pluralize('retry', 'retries', 1)).toBe('retry');
    expect(pluralize('hook', 'hooks', 1)).toBe('hook');
  });

  test('returns plural form when count is 0', () => {
    expect(pluralize('step', 'steps', 0)).toBe('steps');
    expect(pluralize('retry', 'retries', 0)).toBe('retries');
  });

  test('returns plural form when count is greater than 1', () => {
    expect(pluralize('step', 'steps', 2)).toBe('steps');
    expect(pluralize('retry', 'retries', 3)).toBe('retries');
    expect(pluralize('hook', 'hooks', 100)).toBe('hooks');
  });

  test('works with has/have', () => {
    expect(pluralize('has', 'have', 1)).toBe('has');
    expect(pluralize('has', 'have', 2)).toBe('have');
    expect(pluralize('has', 'have', 0)).toBe('have');
  });
});
