/**
 * Entry point for the VM serialization bundle.
 *
 * This file is bundled by esbuild into a self-contained IIFE that
 * sets up serialize/deserialize on globalThis. The bundled output
 * is evaluated inside the QuickJS VM during bootstrap.
 *
 * TextEncoder, TextDecoder, and Headers are provided by native C
 * extensions in quickjs-wasi, so no polyfills are needed.
 */

import { monotonicFactory } from 'ulid';
import { deserialize, serialize } from './workflow-vm.js';

// Install on global scope under the public well-known symbols. The
// snapshot runtime's bootstrap (and the various inline-evaluated JS
// strings in `snapshot-runtime.ts`) reach the same functions via
// `globalThis[Symbol.for('workflow-serialize')]` etc.
(globalThis as any)[Symbol.for('workflow-serialize')] = serialize;
(globalThis as any)[Symbol.for('workflow-deserialize')] = deserialize;

// ULID generator for correlationIds — uses the same monotonicFactory
// as the node:vm engine. Both inputs MUST be set by the host before the
// first ULID is drawn, otherwise the seeded-ULID determinism guarantee
// is silently broken:
//
//   * `Math.random` must be replaced with the host's seeded PRNG via
//     `vm.newFunction('random', …)` (see `quickjs-runtime.ts`, the
//     `Seeded Math.random` block). Two workflow invocations of the same
//     run MUST observe an identical random sequence so their
//     correlationIds collide and the world's EntityConflictError dedup
//     applies. We pass it explicitly to `monotonicFactory` because
//     ULID's auto-detect (`detectPRNG`) only knows about
//     `crypto.getRandomValues` / `crypto.randomBytes`, neither of which
//     exist in QuickJS. The PRNG is deliberately LATE-BOUND (the arrow
//     reads `Math.random` at draw time, not at bundle-eval time) so
//     that this bundle can be evaluated during static VM initialization
//     — before the per-run seeded PRNG is installed — without capturing
//     the unseeded built-in. This is also what allows a future VM
//     snapshot taken after bundle eval to have its PRNG swapped
//     post-restore.
//   * `globalThis.__ulidTimestamp` must be a number (typically
//     `workflowRun.startedAt`). It's used in place of `Date.now()` so
//     the time portion of the ULID is also stable across concurrent
//     invocations of the same run.
//
// The timestamp prerequisite is validated below — fail loudly rather
// than fall back to `Date.now()`, which would re-introduce
// non-determinism that replay relies on us NOT having.
const ulid = monotonicFactory(() => Math.random());
(globalThis as any).__generateUlid = () => {
  const t = (globalThis as any).__ulidTimestamp;
  if (typeof t !== 'number') {
    throw new Error(
      '__generateUlid: globalThis.__ulidTimestamp must be a number set by ' +
        'the host before the serde bundle is evaluated. Without it, ULIDs ' +
        'would fall back to Date.now() and concurrent workflow invocations ' +
        'of the same resumption would produce divergent correlationIds.'
    );
  }
  return ulid(t);
};
