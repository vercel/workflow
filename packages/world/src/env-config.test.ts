import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetEnvWarnCacheForTests, envNumber } from './env-config.js';

const NAME = 'WORKFLOW_TEST_ENV_CONFIG_FIXTURE';
const DEFAULT = 100;

beforeEach(() => {
  delete process.env[NAME];
  _resetEnvWarnCacheForTests();
});

afterEach(() => {
  delete process.env[NAME];
});

describe('envNumber', () => {
  it('returns the default when unset or empty', () => {
    expect(envNumber(NAME, DEFAULT)).toBe(DEFAULT);
    process.env[NAME] = '';
    expect(envNumber(NAME, DEFAULT)).toBe(DEFAULT);
  });

  it('parses a valid override', () => {
    process.env[NAME] = '42';
    expect(envNumber(NAME, DEFAULT)).toBe(42);
  });

  it('accepts fractional values unless integer is required', () => {
    process.env[NAME] = '0.05';
    expect(envNumber(NAME, DEFAULT, { max: 1 })).toBe(0.05);
  });

  it('falls back to default on a non-integer when integer is required', () => {
    process.env[NAME] = '2.5';
    expect(envNumber(NAME, DEFAULT, { integer: true })).toBe(DEFAULT);
  });

  it('falls back to default on non-numeric / non-finite input', () => {
    for (const bad of ['abc', 'NaN', 'Infinity', '']) {
      process.env[NAME] = bad;
      expect(envNumber(NAME, DEFAULT)).toBe(DEFAULT);
    }
  });

  it('clamps up to min (default min is 0, so rejects negatives)', () => {
    process.env[NAME] = '-5';
    expect(envNumber(NAME, DEFAULT)).toBe(0);
    process.env[NAME] = '3';
    expect(envNumber(NAME, DEFAULT, { min: 10 })).toBe(10);
  });

  it('clamps down to max', () => {
    process.env[NAME] = '9999';
    expect(envNumber(NAME, DEFAULT, { max: 500 })).toBe(500);
  });

  it('allows zero when min is 0', () => {
    process.env[NAME] = '0';
    expect(envNumber(NAME, DEFAULT, { integer: true })).toBe(0);
  });
});
