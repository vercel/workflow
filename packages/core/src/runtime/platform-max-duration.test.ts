import { afterEach, describe, expect, it } from 'vitest';
import {
  getPlatformMaxDurationSeconds,
  VERCEL_FUNCTION_MAX_DURATION_ENV,
} from './platform-max-duration.js';

describe('getPlatformMaxDurationSeconds', () => {
  const originalEnv = process.env[VERCEL_FUNCTION_MAX_DURATION_ENV];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[VERCEL_FUNCTION_MAX_DURATION_ENV];
    } else {
      process.env[VERCEL_FUNCTION_MAX_DURATION_ENV] = originalEnv;
    }
  });

  it('returns undefined when the env var is unset', () => {
    delete process.env[VERCEL_FUNCTION_MAX_DURATION_ENV];
    expect(getPlatformMaxDurationSeconds()).toBeUndefined();
  });

  it('returns undefined when the env var is empty', () => {
    process.env[VERCEL_FUNCTION_MAX_DURATION_ENV] = '';
    expect(getPlatformMaxDurationSeconds()).toBeUndefined();
  });

  it('parses a positive integer seconds value', () => {
    process.env[VERCEL_FUNCTION_MAX_DURATION_ENV] = '800';
    expect(getPlatformMaxDurationSeconds()).toBe(800);
  });

  it('returns undefined for non-numeric values', () => {
    process.env[VERCEL_FUNCTION_MAX_DURATION_ENV] = 'blah';
    expect(getPlatformMaxDurationSeconds()).toBeUndefined();
  });
});
