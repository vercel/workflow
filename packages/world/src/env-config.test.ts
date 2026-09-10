import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetEnvWarnCacheForTests,
  envFlag,
  envNumber,
  getMaxEventsPerRun,
} from './env-config.js';

const NAME = 'WORKFLOW_TEST_ENV_CONFIG_FIXTURE';
const MAX_EVENTS_NAME = 'WORKFLOW_MAX_EVENTS';
const DEFAULT = 100;

beforeEach(() => {
  delete process.env[NAME];
  delete process.env[MAX_EVENTS_NAME];
  _resetEnvWarnCacheForTests();
});

afterEach(() => {
  delete process.env[NAME];
  delete process.env[MAX_EVENTS_NAME];
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

describe('getMaxEventsPerRun', () => {
  it.each(['0', '-1'])('uses the default for %s', (value) => {
    process.env[MAX_EVENTS_NAME] = value;
    expect(getMaxEventsPerRun()).toBe(25_000);
  });
});

describe('envFlag', () => {
  it('returns the fallback when unset or empty', () => {
    expect(envFlag(NAME, true)).toBe(true);
    expect(envFlag(NAME, false)).toBe(false);
    expect(envFlag(NAME, true, { [NAME]: '' })).toBe(true);
  });

  it.each(['0', 'false', 'FALSE', 'False'])('reads %s as off', (value) => {
    expect(envFlag(NAME, true, { [NAME]: value })).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'True'])('reads %s as on', (value) => {
    expect(envFlag(NAME, false, { [NAME]: value })).toBe(true);
  });

  // A flag is an escape hatch, so a typo must not take the process down. It
  // falls back and warns rather than throwing or guessing a side.
  it.each([
    'yes',
    'on',
    '2',
    'off',
  ])('falls back on the unrecognized value %s', (value) => {
    expect(envFlag(NAME, true, { [NAME]: value })).toBe(true);
    expect(envFlag(NAME, false, { [NAME]: value })).toBe(false);
  });

  it('reads process.env when no env record is supplied', () => {
    process.env[NAME] = '0';
    expect(envFlag(NAME, true)).toBe(false);
  });
});
