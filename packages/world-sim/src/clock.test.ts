import { describe, expect, it } from 'vitest';
import { createVirtualClock, DEFAULT_EPOCH_MS } from './clock.js';

describe('virtual clock', () => {
  it('starts at the epoch and only moves when told to', () => {
    const clock = createVirtualClock();
    expect(clock.now()).toBe(DEFAULT_EPOCH_MS);
    expect(clock.elapsed()).toBe(0);
    clock.advanceBy(1500);
    expect(clock.elapsed()).toBe(1500);
  });

  it('never moves backwards', () => {
    const clock = createVirtualClock(1000);
    clock.advanceTo(5000);
    clock.advanceTo(2000);
    expect(clock.now()).toBe(5000);
  });

  it('rejects negative advances rather than silently rewinding', () => {
    const clock = createVirtualClock();
    expect(() => clock.advanceBy(-1)).toThrow(/non-negative/);
  });

  it('drives Date.now() and new Date() while installed, and restores after', () => {
    const realNow = Date.now();
    const clock = createVirtualClock(0);
    const uninstall = clock.install();
    try {
      expect(Date.now()).toBe(0);
      // biome-ignore lint/complexity/useDateNow: the point is to check the
      // zero-argument constructor, not just the static.
      expect(new Date().getTime()).toBe(0);
      // Explicit arguments must still behave normally — only the "what time
      // is it" reading is virtual.
      expect(new Date(12345).getTime()).toBe(12345);
      expect(new Date() instanceof Date).toBe(true);
      clock.advanceBy(60_000);
      expect(Date.now()).toBe(60_000);
    } finally {
      uninstall();
    }
    expect(Date.now()).toBeGreaterThanOrEqual(realNow);
  });

  it('keeps `instanceof Date` true across successive clocks', () => {
    // The replay check installs its own clock after the scenario's. If each
    // install swapped in a fresh Date *subclass*, every Date made under the
    // previous one would stop being `instanceof Date` — which silently turns
    // dates into `{}` in any structural clone.
    const first = createVirtualClock(1000);
    const uninstallFirst = first.install();
    const madeUnderFirst = new Date();
    uninstallFirst();

    const second = createVirtualClock(2000);
    const uninstallSecond = second.install();
    try {
      expect(madeUnderFirst instanceof Date).toBe(true);
      expect(madeUnderFirst.getTime()).toBe(1000);
      expect(new Date() instanceof Date).toBe(true);
      expect(Object.prototype.toString.call(madeUnderFirst)).toBe(
        '[object Date]'
      );
    } finally {
      uninstallSecond();
    }
    expect(madeUnderFirst instanceof Date).toBe(true);
  });

  it('refuses to nest, so a leaked scenario cannot shadow the next one', () => {
    const first = createVirtualClock();
    const second = createVirtualClock();
    const uninstall = first.install();
    try {
      expect(() => second.install()).toThrow(/already installed/);
    } finally {
      uninstall();
    }
    // Once the first is uninstalled the second is free to take over.
    second.install()();
  });
});
