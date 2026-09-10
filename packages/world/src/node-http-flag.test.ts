import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetEnvWarnCacheForTests } from './env-config.js';
import {
  isNodeHttpEnabled,
  NODE_HTTP_DEFAULT,
  NODE_HTTP_ENV_VAR,
} from './node-http-flag.js';

beforeEach(() => {
  delete process.env[NODE_HTTP_ENV_VAR];
  _resetEnvWarnCacheForTests();
});

afterEach(() => {
  delete process.env[NODE_HTTP_ENV_VAR];
});

describe('isNodeHttpEnabled', () => {
  it('follows the compiled-in default when unset', () => {
    expect(isNodeHttpEnabled()).toBe(NODE_HTTP_DEFAULT);
  });

  it('is switchable in both directions', () => {
    expect(isNodeHttpEnabled({ [NODE_HTTP_ENV_VAR]: '1' })).toBe(true);
    expect(isNodeHttpEnabled({ [NODE_HTTP_ENV_VAR]: '0' })).toBe(false);
    expect(isNodeHttpEnabled({ [NODE_HTTP_ENV_VAR]: 'true' })).toBe(true);
    expect(isNodeHttpEnabled({ [NODE_HTTP_ENV_VAR]: 'false' })).toBe(false);
  });

  it('reads process.env by default', () => {
    process.env[NODE_HTTP_ENV_VAR] = '0';
    expect(isNodeHttpEnabled()).toBe(false);
    process.env[NODE_HTTP_ENV_VAR] = '1';
    expect(isNodeHttpEnabled()).toBe(true);
  });
});
