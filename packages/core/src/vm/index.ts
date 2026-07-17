import { createHash } from 'node:crypto';
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

// biome-ignore lint/style/noNonNullAssertion: byteLength always exists on ArrayBuffer.prototype
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength'
)!.get!;

// WebCrypto BufferSource conversion: views pass through; anything else must
// be a real ArrayBuffer (the native byteLength getter is a brand check that
// works across vm realms) so that e.g. a plain number is rejected with
// TypeError instead of allocating a Uint8Array of that length.
function toDigestBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  arrayBufferByteLength.call(data);
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

  // Track every sandbox API whose promise resolves on host timing rather
  // than from the event log: `Atomics.waitAsync` (a wall-clock timer via
  // SharedArrayBuffer) and the async `WebAssembly` compilation entry points.
  // These are the only ways a suspended workflow can make progress the event
  // log cannot replay, so the runtime declines to retain a VM that used any
  // of them (see `canRetainWorkflowSession`). Dynamic `import()` settles
  // within a microtask (rejected: no `importModuleDynamically`), so it
  // cannot advance a suspended VM.
  let usedHostAsync = false;
  const trackHostAsync = (
    target: Record<string, unknown>,
    method: string
  ): void => {
    const original = target[method];
    if (typeof original !== 'function') return;
    target[method] = (...args: unknown[]) => {
      usedHostAsync = true;
      return Reflect.apply(original, target, args);
    };
  };
  const intrinsics = g as unknown as Record<string, Record<string, unknown>>;
  trackHostAsync(intrinsics.Atomics, 'waitAsync');
  trackHostAsync(intrinsics.WebAssembly, 'compile');
  trackHostAsync(intrinsics.WebAssembly, 'instantiate');
  trackHostAsync(intrinsics.WebAssembly, 'compileStreaming');
  trackHostAsync(intrinsics.WebAssembly, 'instantiateStreaming');

  // GC observation (`WeakRef.deref()`, finalizer callbacks) depends on host
  // GC timing that neither replay nor a retained VM can reconstruct from the
  // event log, so the sandbox does not expose it at all.
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
    usedHostAsync: () => usedHostAsync,
  };
}
