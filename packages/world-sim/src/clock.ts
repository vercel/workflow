/**
 * Virtual clock.
 *
 * The runtime decides when a `sleep()` has elapsed by comparing the wait's
 * stored `resumeAt` against host `Date.now()` (see the "complete elapsed
 * waits" pass in `@workflow/core`'s runtime). A simulation that wants
 * scenarios to terminate in milliseconds therefore cannot leave the host
 * clock alone: it has to be able to jump the process forward to the next
 * scheduled deadline.
 *
 * So the clock here is authoritative for the whole scenario, and `install()`
 * patches `Date.now()` and the zero-argument `Date` constructor to read it.
 * Timers are deliberately NOT patched: `@workflow/core` uses
 * `setTimeout(fn, 0)` as a macrotask barrier in several ordering-sensitive
 * places (`events-consumer.ts`, `private.ts`), and swapping those for fake
 * timers would change the very interleavings the simulation exists to
 * observe. Real zero-delay timers stay real; only the *readings* of wall
 * time move under our control.
 *
 * The clock never moves on its own — only `advanceTo`/`advanceBy` move it,
 * and only the scheduler calls those. Two runs of the same scenario see the
 * exact same sequence of timestamps.
 */

/** Default epoch: 2024-01-01T00:00:00.000Z. Arbitrary, but fixed and readable. */
export const DEFAULT_EPOCH_MS = 1_704_067_200_000;

export interface VirtualClock {
  /** Current virtual time, in epoch milliseconds. */
  now(): number;
  /** Milliseconds elapsed since the clock's epoch. */
  elapsed(): number;
  /** Move time forward to `ms`. Never moves backwards. */
  advanceTo(ms: number): void;
  /** Move time forward by `ms` (must be >= 0). */
  advanceBy(ms: number): void;
  /**
   * Patch host `Date.now()` / `new Date()` to read this clock. Returns the
   * uninstall function. Nested installs are rejected so a leaked scenario
   * can't silently shadow the next one's clock.
   */
  install(): () => void;
}

let installedClock: VirtualClock | undefined;

export function createVirtualClock(epochMs = DEFAULT_EPOCH_MS): VirtualClock {
  let current = epochMs;

  const clock: VirtualClock = {
    now: () => current,
    elapsed: () => current - epochMs,
    advanceTo(ms) {
      if (ms > current) current = ms;
    },
    advanceBy(ms) {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`advanceBy expects a non-negative duration, got ${ms}`);
      }
      current += ms;
    },
    install() {
      if (installedClock && installedClock !== clock) {
        throw new Error(
          'A virtual clock is already installed. Scenarios must run one at a time.'
        );
      }
      installedClock = clock;

      const RealDate = globalThis.Date;

      // A Proxy, deliberately not a subclass.
      //
      // Subclassing works right up until two clocks are installed in
      // succession — a scenario's, then the replay check's. Every `Date` the
      // first clock produced is an instance of *that* subclass, so once the
      // second one is installed `x instanceof Date` is false for all of them,
      // and any code branching on it (a structural clone, a serializer)
      // silently mistakes a Date for a plain object. A Proxy keeps
      // `Date.prototype` identical to the real one, so `instanceof` stays true
      // for every Date ever made, whichever clock is installed.
      const proxy = new Proxy(RealDate, {
        construct(target, args, newTarget) {
          // Only the zero-argument "what time is it" form is virtual.
          return Reflect.construct(
            target,
            args.length === 0 ? [current] : args,
            newTarget
          );
        },
        apply() {
          // `Date()` called as a function ignores its arguments and returns
          // the current time as a string.
          return new RealDate(current).toString();
        },
        get(target, prop, receiver) {
          if (prop === 'now') return () => current;
          return Reflect.get(target, prop, receiver);
        },
      });

      globalThis.Date = proxy as DateConstructor;

      return () => {
        if (installedClock !== clock) return;
        globalThis.Date = RealDate;
        installedClock = undefined;
      };
    },
  };

  return clock;
}
