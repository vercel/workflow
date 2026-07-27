import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { runInContext, createContext as vmCreateContext } from 'node:vm';
import { WorkflowRuntimeError } from '@workflow/errors';
import seedrandom from 'seedrandom';
import { installUint8ArrayBase64 } from './uint8array-base64.js';
import { createRandomUUID } from './uuid.js';

export interface CreateContextOptions {
  seed: string;
  // Fixed timestamp for deterministic Date operations
  fixedTimestamp: number;
  /**
   * Immutable environment captured for this workflow delivery. Supplying it
   * lets fresh replay VMs observe the same environment without exposing the
   * host `process` object.
   */
  environment?: EnvironmentSnapshot;
}

export type EnvironmentSnapshot = Readonly<NodeJS.ProcessEnv>;

/** Capture the host environment once for deterministic workflow replays. */
export function snapshotEnvironment(): EnvironmentSnapshot {
  return Object.freeze({ ...process.env });
}

// WebCrypto digest algorithm names → node:crypto (OpenSSL) names.
const DIGEST_ALGORITHMS: Record<string, string> = {
  'SHA-1': 'sha1',
  'SHA-256': 'sha256',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
};

// WebCrypto BufferSource conversion. The `util.types` brand checks work
// across vm realms, and node:crypto's `hash.update()` reads view ranges from
// internal slots (own properties shadowing `byteOffset`/`byteLength` are
// ignored) — matching WebCrypto, which also reads internal slots.
function toDigestInput(
  data: ArrayBuffer | ArrayBufferView
): NodeJS.ArrayBufferView {
  if (types.isTypedArray(data) || types.isDataView(data)) {
    // WebCrypto's BufferSource excludes SharedArrayBuffer-backed views.
    if (types.isSharedArrayBuffer(data.buffer)) {
      throw new TypeError(
        'crypto.subtle.digest does not accept SharedArrayBuffer-backed views'
      );
    }
    return data;
  }
  if (!types.isArrayBuffer(data)) {
    throw new TypeError('data must be an ArrayBuffer or ArrayBufferView');
  }
  return new Uint8Array(data);
}

/**
 * Creates a Node.js `vm.Context` configured to be usable for
 * executing workflow logic in a deterministic environment.
 *
 * @param options - The options for the context.
 * @returns The context.
 */
export function createContext(options: CreateContextOptions) {
  let { fixedTimestamp } = options;
  const { seed, environment = snapshotEnvironment() } = options;
  const rng = seedrandom(seed);
  const context = vmCreateContext();

  const g: typeof globalThis = runInContext('globalThis', context);

  // Deterministic `Math.random()`
  g.Math.random = rng;

  // Override `Date` constructor to return fixed time when called without arguments
  const Date_ = g.Date;
  // biome-ignore lint/suspicious/noShadowRestrictedNames: We're shadowing the global `Date` property to make it deterministic.
  (g as any).Date = function Date(
    ...args: Parameters<(typeof globalThis)['Date']>[]
  ) {
    if (args.length === 0) {
      return new Date_(fixedTimestamp);
    }
    // @ts-expect-error - Args is `Date` constructor arguments
    return new Date_(...args);
  };
  (g as any).Date.prototype = Date_.prototype;
  // Preserve static methods
  Object.setPrototypeOf(g.Date, Date_);
  g.Date.now = () => fixedTimestamp;

  // Deterministic `crypto` using Proxy to avoid mutating global objects
  const originalCrypto = globalThis.crypto;
  const originalSubtle = originalCrypto.subtle;

  function getRandomValues(array: Uint8Array) {
    for (let i = 0; i < array.length; i++) {
      array[i] = Math.floor(rng() * 256);
    }
    return array;
  }

  const randomUUID = createRandomUUID(rng);

  // The sandbox must not hand workflow code a promise that settles on host
  // timing or a way to observe host state (best-effort, for non-adversarial
  // code): every promise a workflow creates settles either from the event log
  // or within its own microtask cascade, so a suspended VM is fully quiescent
  // and can be retained across inline steps.
  //
  // - `Atomics.waitAsync` is a wall-clock timer (via SharedArrayBuffer).
  // - The async `WebAssembly` entry points resolve on compile-thread timing;
  //   the synchronous `new WebAssembly.Module()` / `Instance()` remain.
  // - `WeakRef.deref()` and finalizer callbacks observe GC timing.
  // - Dynamic `import()` settles within a microtask (rejected: no
  //   `importModuleDynamically`), so it needs no handling.
  // - All `crypto.subtle` methods except the deterministic `digest` override
  //   below throw explicitly (see the subtle proxy) — binding them to the
  //   host subtle would hand workflows a host-timing promise.
  const intrinsics = g as unknown as Record<string, Record<string, unknown>>;
  delete intrinsics.Atomics.waitAsync;
  delete intrinsics.WebAssembly.compile;
  delete intrinsics.WebAssembly.instantiate;
  delete intrinsics.WebAssembly.compileStreaming;
  delete intrinsics.WebAssembly.instantiateStreaming;
  delete intrinsics.WeakRef;
  delete intrinsics.FinalizationRegistry;

  // `crypto.subtle.digest` computes synchronously via node:crypto, so its
  // promise settles on a deterministic microtask instead of host threadpool
  // timing — a digest can never advance a suspended workflow, and
  // digest-using VMs stay retainable. Values are byte-identical to WebCrypto.
  const digest = async (
    algorithm: string | { name: string },
    data: ArrayBuffer | ArrayBufferView
  ): Promise<ArrayBuffer> => {
    const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
    const ossl = DIGEST_ALGORITHMS[name.toUpperCase()];
    if (!ossl) {
      throw new DOMException(
        `Unrecognized algorithm name: ${name}`,
        'NotSupportedError'
      );
    }
    const hash = createHash(ossl).update(toDigestInput(data)).digest();
    // Copy out: small Buffers share the internal pool allocation.
    const out = new ArrayBuffer(hash.byteLength);
    new Uint8Array(out).set(hash);
    return out;
  };

  g.crypto = new Proxy(originalCrypto, {
    get(target, prop) {
      if (prop === 'getRandomValues') {
        return getRandomValues;
      }
      if (prop === 'randomUUID') {
        return randomUUID;
      }
      if (prop === 'subtle') {
        return new Proxy(originalSubtle, {
          get(target, prop) {
            if (prop === 'digest') {
              return digest;
            }
            const value = target[prop as keyof typeof originalSubtle];
            if (typeof value !== 'function') {
              return value;
            }
            // Every other subtle method (`encrypt`, `sign`, `importKey`, …)
            // settles on host threadpool timing, which cannot be replayed.
            return () => {
              throw new WorkflowRuntimeError(
                `\`crypto.subtle.${String(prop)}()\` is not available inside a workflow function. Move it to a step function where full Node.js crypto is available.`
              );
            };
          },
        });
      }
      return target[prop as keyof typeof originalCrypto];
    },
  });

  // Propagate environment variables
  (g as any).process = {
    env: environment,
  };

  // Stateless + synchronous Web APIs that are made available inside the sandbox
  g.DOMException = globalThis.DOMException;
  g.Headers = globalThis.Headers;
  g.TextEncoder = globalThis.TextEncoder;
  g.TextDecoder = globalThis.TextDecoder;
  g.console = globalThis.console;
  g.URL = globalThis.URL;
  g.URLSearchParams = globalThis.URLSearchParams;
  g.structuredClone = globalThis.structuredClone;
  g.atob = globalThis.atob;
  g.btoa = globalThis.btoa;

  // TC39 Uint8Array base64/hex polyfill (proposal-arraybuffer-base64)
  installUint8ArrayBase64(g.Uint8Array);

  // TC39 Explicit Resource Management polyfill for `using` keyword
  (g.Symbol as any).dispose ??= Symbol.for('Symbol.dispose');
  (g.Symbol as any).asyncDispose ??= Symbol.for('Symbol.asyncDispose');

  // HACK: Shim `exports` for the bundle
  g.exports = {};
  (g as any).module = { exports: g.exports };

  return {
    context,
    globalThis: g,
    updateTimestamp: (timestamp: number) => {
      fixedTimestamp = timestamp;
    },
  };
}
