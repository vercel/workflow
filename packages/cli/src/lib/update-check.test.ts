import { describe, expect, it } from 'vitest';
import { isBetaVersion } from './update-check.js';

describe('isBetaVersion', () => {
  it('is true for beta releases', () => {
    expect(isBetaVersion('5.0.0-beta.58')).toBe(true);
    expect(isBetaVersion('4.0.1-beta.1')).toBe(true);
    expect(isBetaVersion('5.0.0-beta')).toBe(true);
    expect(isBetaVersion('5.0.0-beta.1+build.7')).toBe(true);
  });

  it('is false for stable releases', () => {
    expect(isBetaVersion('5.3.0')).toBe(false);
    expect(isBetaVersion('4.3.20')).toBe(false);
    expect(isBetaVersion('5.3.0+build.1')).toBe(false);
  });

  it('is false for non-beta prerelease builds', () => {
    expect(isBetaVersion('5.2.0-25050c7')).toBe(false);
    expect(isBetaVersion('5.2.0-canary.3')).toBe(false);
    expect(isBetaVersion('5.2.0-betamax.1')).toBe(false);
  });
});
