import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDeterministicContext } from './deterministic.js';

describe('createDeterministicContext', () => {
  let originalMathRandom: typeof Math.random;
  let originalDateNow: typeof Date.now;

  beforeEach(() => {
    originalMathRandom = Math.random;
    originalDateNow = Date.now;
  });

  afterEach(() => {
    // Restore in case test fails to call restore
    Math.random = originalMathRandom;
    Date.now = originalDateNow;
  });

  it('should produce deterministic Math.random values for the same seed', () => {
    const ctx1 = createDeterministicContext('test-seed', 1000);
    const values1 = [Math.random(), Math.random(), Math.random()];
    ctx1.restore();

    const ctx2 = createDeterministicContext('test-seed', 1000);
    const values2 = [Math.random(), Math.random(), Math.random()];
    ctx2.restore();

    expect(values1).toEqual(values2);
  });

  it('should produce different values for different seeds', () => {
    const ctx1 = createDeterministicContext('seed-1', 1000);
    const values1 = [Math.random(), Math.random()];
    ctx1.restore();

    const ctx2 = createDeterministicContext('seed-2', 1000);
    const values2 = [Math.random(), Math.random()];
    ctx2.restore();

    expect(values1).not.toEqual(values2);
  });

  it('should return fixed timestamp from Date.now()', () => {
    const fixedTime = 1699000000000;
    const ctx = createDeterministicContext('seed', fixedTime);

    expect(Date.now()).toBe(fixedTime);
    expect(Date.now()).toBe(fixedTime);

    ctx.restore();
  });

  it('should allow updating the timestamp', () => {
    const initialTime = 1699000000000;
    const ctx = createDeterministicContext('seed', initialTime);

    expect(Date.now()).toBe(initialTime);

    const newTime = 1699000001000;
    ctx.updateTimestamp(newTime);

    expect(Date.now()).toBe(newTime);
    expect(ctx.getTimestamp()).toBe(newTime);

    ctx.restore();
  });

  it('should restore original functions after restore()', () => {
    const ctx = createDeterministicContext('seed', 1000);

    // Verify patched
    expect(Date.now()).toBe(1000);

    ctx.restore();

    // Verify restored
    expect(Date.now).toBe(originalDateNow);
    expect(Math.random).toBe(originalMathRandom);

    // Date.now should return real time now
    const realTime = Date.now();
    expect(realTime).toBeGreaterThan(1000);
  });

  it('should create new Date() with fixed timestamp when no args', () => {
    const fixedTime = 1699000000000;
    const ctx = createDeterministicContext('seed', fixedTime);

    const date = new Date();
    expect(date.getTime()).toBe(fixedTime);

    ctx.restore();
  });

  it('should create new Date() normally when args provided', () => {
    const fixedTime = 1699000000000;
    const ctx = createDeterministicContext('seed', fixedTime);

    const customTime = 1500000000000;
    const date = new Date(customTime);
    expect(date.getTime()).toBe(customTime);

    ctx.restore();
  });
});
