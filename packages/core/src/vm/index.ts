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
}

// WebCrypto digest algorithm names → node:crypto (OpenSSL) names.
const DIGEST_ALGORITHMS: Record<string, string> = {
  'SHA-1': 'sha1',
  'SHA-256': 'sha256',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
};

// Intrinsic prototype getters, captured so view metadata is read from
// internal slots like WebCrypto's BufferSource conversion — own properties
// shadowing `buffer`/`byteOffset`/`byteLength` on a view must not change
// which bytes are hashed.
function intrinsicGetter(prototype: object, name: string) {
  // biome-ignore lint/style/noNonNullAssertion: intrinsic accessors always exist
  return Object.getOwnPropertyDescriptor(prototype, name)!.get!;
}
const arrayBufferByteLength = intrinsicGetter(
  ArrayBuffer.prototype,
  'byteLength'
);
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype
) as object;
const viewGetters = {
  typedArray: {
    buffer: intrinsicGetter(typedArrayPrototype, 'buffer'),
    byteOffset: intrinsicGetter(typedArrayPrototype, 'byteOffset'),
    byteLength: intrinsicGetter(typedArrayPrototype, 'byteLength'),
  },
  dataView: {
    buffer: intrinsicGetter(DataView.prototype, 'buffer'),
    byteOffset: intrinsicGetter(DataView.prototype, 'byteOffset'),
    byteLength: intrinsicGetter(DataView.prototype, 'byteLength'),
  },
};

// WebCrypto BufferSource conversion: typed-array/DataView views are read via
// internal slots; anything else must be a real ArrayBuffer (the native
// byteLength getter is a brand check that works across vm realms) so that
// e.g. a plain number is rejected with TypeError instead of allocating a
// Uint8Array of that length.
function toDigestBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (types.isTypedArray(data) || types.isDataView(data)) {
    const getters = types.isDataView(data)
      ? viewGetters.dataView
      : viewGetters.typedArray;
    const buffer = getters.buffer.call(data) as ArrayBuffer;
    // WebCrypto's BufferSource excludes SharedArrayBuffer-backed views.
    if (types.isSharedArrayBuffer(buffer)) {
      throw new TypeError(
        'crypto.subtle.digest does not accept SharedArrayBuffer-backed views'
      );
    }
    return new Uint8Array(
      buffer,
      getters.byteOffset.call(data) as number,
      getters.byteLength.call(data) as number
    );
  }
  arrayBufferByteLength.call(data);
  return new Uint8Array(data as ArrayBuffer);
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
  const { seed } = options;
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

  // The sandbox must not expose any way for workflow code to observe host
  // timing or host state: after this block, every promise a workflow can
  // create settles either from the event log or within its own microtask
  // cascade, so a suspended VM is fully quiescent and can be retained across
  // inline steps.
  //
  // - `Atomics.waitAsync` is a wall-clock timer (via SharedArrayBuffer).
  // - The async `WebAssembly` entry points resolve on compile-thread timing;
  //   the synchronous `new WebAssembly.Module()` / `Instance()` remain.
  // - `WeakRef.deref()` and finalizer callbacks observe GC timing.
  // - Dynamic `import()` settles within a microtask (rejected: no
  //   `importModuleDynamically`), so it needs no handling.
  // - The remaining async `crypto.subtle` methods (`encrypt`, `sign`,
  //   `importKey`, …) would settle on host threadpool timing, but none of
  //   them are usable: invoked through the crypto proxy below the receiver
  //   is not a real SubtleCrypto, so the brand check rejects immediately
  //   ("Value of 'this' must be of type SubtleCrypto") before any crypto
  //   work is scheduled — a deterministic microtask rejection. Only the
  //   deterministic overrides (`digest`, `getRandomValues`, `randomUUID`)
  //   and the explicit `generateKey` error do real work — locked in by a
  //   test. Do not "fix" those methods by binding them to the host subtle:
  //   that would hand workflows a host-timing promise.
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
  const digest = (
    algorithm: string | { name: string },
    data: ArrayBuffer | ArrayBufferView
  ): Promise<ArrayBuffer> => {
    try {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
      const ossl = DIGEST_ALGORITHMS[name.toUpperCase()];
      if (!ossl) {
        throw new DOMException(
          `Unrecognized algorithm name: ${name}`,
          'NotSupportedError'
        );
      }
      const hash = createHash(ossl).update(toDigestBytes(data)).digest();
      // Copy out: small Buffers share the internal pool allocation.
      const out = new ArrayBuffer(hash.byteLength);
      new Uint8Array(out).set(hash);
      return Promise.resolve(out);
    } catch (error) {
      return Promise.reject(error);
    }
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
            if (prop === 'generateKey') {
              return () => {
                throw new WorkflowRuntimeError(
                  '`crypto.subtle.generateKey()` is not available inside a workflow function. Move key generation to a step function where full Node.js crypto is available.'
                );
              };
            } else if (prop === 'digest') {
              return digest;
            }
            return target[prop as keyof typeof originalSubtle];
          },
        });
      }
      return target[prop as keyof typeof originalCrypto];
    },
  });

  // Propagate environment variables
  (g as any).process = {
    env: Object.freeze({ ...process.env }),
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
