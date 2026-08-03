/**
 * QuickJS VM binary assets, with a host-installable override.
 *
 * By default the engine uses `quickjs-assets.generated.ts`: the quickjs-wasi
 * WASM binary and its native extensions, base64-embedded in JavaScript and
 * decoded at import time. That default is deliberately filesystem-free and
 * bundler-agnostic, which is what makes it work unchanged on Node, Vercel
 * Functions, and any bundler that can't trace `import.meta.url`.
 *
 * It does NOT work everywhere, though: passing raw bytes to
 * `QuickJS.create()` means the WASM is compiled at runtime, and some
 * embedders forbid that. Cloudflare's workerd rejects
 * `WebAssembly.compile(bytes)` outright ("Wasm code generation disallowed by
 * embedder") — WASM must instead be compiled at bundle time and imported as
 * a `WebAssembly.Module`. Such a host calls {@link setQuickJSAssets} during
 * module initialization to install its pre-compiled modules; the engine then
 * never touches the byte-decoding path.
 *
 * The override is process-global and set-once-at-startup by design: the
 * assets are immutable build artifacts, not per-run state.
 */

import type { ExtensionDescriptor } from 'quickjs-wasi';
import {
  quickjsExtensions as generatedExtensions,
  quickjsWasm as generatedWasm,
} from './quickjs-assets.generated.js';

export interface QuickJSAssets {
  /**
   * The QuickJS WASM binary — raw bytes (compiled at runtime) or an
   * already-compiled `WebAssembly.Module`.
   */
  quickjsWasm: Uint8Array | WebAssembly.Module;
  /** Native C extensions, in the order the engine expects them. */
  quickjsExtensions: ExtensionDescriptor[];
}

let override: QuickJSAssets | undefined;

/**
 * Install host-provided QuickJS assets, replacing the generated defaults.
 *
 * Call this once, before the first workflow invocation. Intended for
 * runtimes that cannot compile WASM from bytes and must supply
 * `WebAssembly.Module`s produced at bundle time (e.g. Cloudflare Workers).
 */
export function setQuickJSAssets(assets: QuickJSAssets): void {
  override = assets;
}

/** The assets the engine should use: the host override, else the defaults. */
export function getQuickJSAssets(): QuickJSAssets {
  return (
    override ?? {
      quickjsWasm: generatedWasm,
      quickjsExtensions: generatedExtensions,
    }
  );
}
