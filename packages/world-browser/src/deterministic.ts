/**
 * Deterministic context for browser workflow execution.
 *
 * This replaces node:vm by patching global functions to be deterministic
 * based on a seed value. This ensures workflow replay produces identical
 * results for Math.random(), Date.now(), and crypto.randomUUID().
 */

import seedrandom from 'seedrandom';

export interface DeterministicContext {
  /**
   * Restore original global functions.
   */
  restore: () => void;

  /**
   * Update the fixed timestamp used by Date.now() and new Date().
   */
  updateTimestamp: (timestamp: number) => void;

  /**
   * Get the current fixed timestamp.
   */
  getTimestamp: () => number;
}

interface OriginalGlobals {
  mathRandom: typeof Math.random;
  dateNow: typeof Date.now;
  dateConstructor: DateConstructor;
  cryptoRandomUUID: typeof crypto.randomUUID;
  cryptoGetRandomValues: typeof crypto.getRandomValues;
}

/**
 * Generate a deterministic UUID v4 using the seeded RNG.
 */
function createSeededUUID(
  rng: () => number
): () => `${string}-${string}-${string}-${string}-${string}` {
  return () => {
    // Generate 16 random bytes
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(rng() * 256);
    }

    // Set version (4) and variant (8, 9, A, or B)
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    // Convert to hex string
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
      ''
    );

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
  };
}

/**
 * Create a deterministic context for workflow execution.
 *
 * This patches global functions to be deterministic based on the seed.
 * Call `restore()` after workflow execution to restore original behavior.
 *
 * @param seed - Seed for random number generation (typically runId)
 * @param initialTimestamp - Initial fixed timestamp for Date operations
 */
export function createDeterministicContext(
  seed: string,
  initialTimestamp: number
): DeterministicContext {
  let fixedTimestamp = initialTimestamp;

  // Create seeded RNG
  const rng = seedrandom(seed);

  // Store original functions
  const original: OriginalGlobals = {
    mathRandom: Math.random,
    dateNow: Date.now,
    dateConstructor: Date,
    cryptoRandomUUID: crypto.randomUUID.bind(crypto),
    cryptoGetRandomValues: crypto.getRandomValues.bind(crypto),
  };

  // Create seeded UUID generator
  const seededUUID = createSeededUUID(rng);

  // Patch Math.random
  Math.random = () => rng();

  // Patch Date.now
  Date.now = () => fixedTimestamp;

  // Patch Date constructor - we only override Date.now() and leave constructor
  // relatively untouched since the primary concern is deterministic timestamps
  const OriginalDate = original.dateConstructor;

  // Create a proxy-based Date constructor that intercepts no-arg calls
  const PatchedDateConstructor = new Proxy(OriginalDate, {
    construct(target, args: unknown[]) {
      if (args.length === 0) {
        return new target(fixedTimestamp);
      }
      // Use Reflect.construct for proper spread
      return Reflect.construct(target, args);
    },
    apply(_target, _thisArg, args: unknown[]) {
      // Date() called as function returns string representation
      if (args.length === 0) {
        return new OriginalDate(fixedTimestamp).toString();
      }
      // Use Function.prototype.apply for proper spread
      return OriginalDate.apply(null, args as []).toString();
    },
    get(target, prop, receiver) {
      if (prop === 'now') {
        return () => fixedTimestamp;
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  // @ts-ignore - replacing global Date with proxy
  globalThis.Date = PatchedDateConstructor;

  // Patch crypto.randomUUID
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    crypto.randomUUID = seededUUID;
  }

  // Patch crypto.getRandomValues for deterministic random bytes
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues = function <T extends ArrayBufferView | null>(
      array: T
    ): T {
      if (array === null) return array;

      const view = array as unknown as Uint8Array;
      if (view.length !== undefined) {
        for (let i = 0; i < view.length; i++) {
          view[i] = Math.floor(rng() * 256);
        }
      }
      return array;
    };
  }

  return {
    restore: () => {
      Math.random = original.mathRandom;
      Date.now = original.dateNow;
      // @ts-ignore - restoring global Date
      globalThis.Date = original.dateConstructor;
      if (typeof crypto !== 'undefined') {
        crypto.randomUUID = original.cryptoRandomUUID;
        crypto.getRandomValues = original.cryptoGetRandomValues;
      }
    },

    updateTimestamp: (timestamp: number) => {
      fixedTimestamp = timestamp;
    },

    getTimestamp: () => fixedTimestamp,
  };
}
