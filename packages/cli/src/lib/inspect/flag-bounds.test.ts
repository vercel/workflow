import { describe, expect, it } from 'vitest';
import { validateInspectLimit, validateInspectRunId } from './flag-bounds.js';

describe('validateInspectLimit', () => {
  it.each([1, 20, 100, 1000])('accepts %s', (limit) => {
    expect(validateInspectLimit(limit)).toBeUndefined();
  });

  it.each([
    0,
    -1,
    1001,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects %s and names the flag', (limit) => {
    expect(validateInspectLimit(limit)).toBe(
      '--limit must be an integer between 1 and 1000.'
    );
  });
});

describe('validateInspectRunId', () => {
  it('accepts a well-formed run id', () => {
    expect(
      validateInspectRunId('wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE')
    ).toBeUndefined();
  });

  // The backend accepts neither of these, so catching them here saves a round
  // trip and names the flag.
  it.each([
    ['a lowercase body', 'wrun_01k4bzq5t2j8hxfm6wd3pnavce'],
    ['a first character above 7', 'wrun_81K4BZQ5T2J8HXFM6WD3PNAVCE'],
    ['a non-Crockford character', 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCI'],
    ['the wrong prefix', 'step_01K4BZQ5T2J8HXFM6WD3PNAVCE'],
    ['no prefix', '01K4BZQ5T2J8HXFM6WD3PNAVCE'],
    ['a truncated body', 'wrun_01K4BZQ'],
    ['nothing', ''],
  ])('rejects %s', (_label, runId) => {
    expect(validateInspectRunId(runId)).toContain('--runId must be a run id');
  });
});
