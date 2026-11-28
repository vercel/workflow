import { WorkflowRuntimeError } from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import {
  assertWorldSupportsInBandFence,
  assertWorldSupportsRateLimits,
} from './world-compatibility.js';

describe('assertWorldSupportsInBandFence', () => {
  it('accepts a World that declares the in-band fence', () => {
    expect(() =>
      assertWorldSupportsInBandFence({ capabilities: { inBandFence: true } })
    ).not.toThrow();
  });

  it.each([
    ['no capabilities', undefined],
    ['capabilities without the fence', { maxConcurrency: true }],
    ['the fence declared false', { inBandFence: false }],
  ])('rejects a World with %s', (_label, capabilities) => {
    let error: unknown;
    try {
      assertWorldSupportsInBandFence({ capabilities });
    } catch (err) {
      error = err;
    }
    expect(WorkflowRuntimeError.is(error)).toBe(true);
    expect((error as Error).message).toMatch(/capabilities\.inBandFence/);
  });
});

describe('assertWorldSupportsRateLimits', () => {
  it('accepts a World that reserves rate limit slots', () => {
    expect(() =>
      assertWorldSupportsRateLimits({
        capabilities: { inBandFence: true, rateLimits: true },
      })
    ).not.toThrow();
  });

  it.each([
    ['no capabilities', undefined],
    ['the fence alone', { inBandFence: true }],
    ['rate limits declared false', { inBandFence: true, rateLimits: false }],
  ])('rejects a World with %s', (_label, capabilities) => {
    let error: unknown;
    try {
      assertWorldSupportsRateLimits({ capabilities });
    } catch (err) {
      error = err;
    }
    expect(WorkflowRuntimeError.is(error)).toBe(true);
    expect((error as Error).message).toMatch(/capabilities\.rateLimits/);
  });
});
