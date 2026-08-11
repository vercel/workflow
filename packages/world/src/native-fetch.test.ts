import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetEnvWarnCacheForTests } from './env-config.js';
import {
  isNativeFetchEnabled,
  NATIVE_FETCH_DEFAULT,
  NATIVE_FETCH_ENV_VAR,
} from './native-fetch.js';

beforeEach(() => {
  delete process.env[NATIVE_FETCH_ENV_VAR];
  _resetEnvWarnCacheForTests();
});

afterEach(() => {
  delete process.env[NATIVE_FETCH_ENV_VAR];
});

describe('isNativeFetchEnabled', () => {
  it('follows the compiled-in default when unset', () => {
    expect(isNativeFetchEnabled()).toBe(NATIVE_FETCH_DEFAULT);
  });

  it('is switchable in both directions', () => {
    expect(isNativeFetchEnabled({ [NATIVE_FETCH_ENV_VAR]: '1' })).toBe(true);
    expect(isNativeFetchEnabled({ [NATIVE_FETCH_ENV_VAR]: '0' })).toBe(false);
    expect(isNativeFetchEnabled({ [NATIVE_FETCH_ENV_VAR]: 'true' })).toBe(true);
    expect(isNativeFetchEnabled({ [NATIVE_FETCH_ENV_VAR]: 'false' })).toBe(
      false
    );
  });

  it('reads process.env by default', () => {
    process.env[NATIVE_FETCH_ENV_VAR] = '0';
    expect(isNativeFetchEnabled()).toBe(false);
    process.env[NATIVE_FETCH_ENV_VAR] = '1';
    expect(isNativeFetchEnabled()).toBe(true);
  });
});
