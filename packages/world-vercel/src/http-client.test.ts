import { describe, expect, it } from 'vitest';
import { getDispatcher } from './http-client.js';

describe('getDispatcher', () => {
  it('returns the shared default dispatcher when none is provided', () => {
    expect(getDispatcher()).toBe(getDispatcher());
    expect(getDispatcher({})).toBe(getDispatcher());
  });

  it('returns the caller-supplied dispatcher when provided', () => {
    const custom = {};
    expect(getDispatcher({ dispatcher: custom })).toBe(custom);
  });
});
