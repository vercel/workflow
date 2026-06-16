/**
 * Browser zstd decoder for the o11y read path.
 *
 * The Web `DecompressionStream` has no zstd support, so `@workflow/core`'s
 * `hydrateDataWithKey` delegates zstd inflation to a decoder registered via
 * `registerZstdDecoder`. This module supplies that decoder, backed by the
 * `@tootallnate/zstd-wasm` single-file WASM decoder.
 *
 * The package leaves WASM sourcing to the caller. We **vendor** its
 * `zstd.wasm` next to this module in `dist/lib/` (copied by the build
 * script) and reference it with a **relative** `new URL('./zstd.wasm',
 * import.meta.url)` — the same pattern the trace-viewer Worker uses. A
 * relative asset URL is what every bundler (Vite, webpack, Turbopack)
 * reliably rewrites; a bare package specifier is left untouched by Vite and
 * 404s in the browser. The WASM is fetched + compiled once, lazily — only
 * the first time a zstd payload is actually decoded.
 */
import { registerZstdDecoder } from '@workflow/core/serialization-format';

let registered = false;
let modulePromise: Promise<WebAssembly.Module> | undefined;

function loadWasmModule(): Promise<WebAssembly.Module> {
  if (!modulePromise) {
    // Relative to the built module (dist/lib/zstd-browser-decoder.js); the
    // build vendors zstd.wasm alongside it as dist/lib/zstd.wasm.
    const url = new URL('./zstd.wasm', import.meta.url);
    modulePromise = fetch(url)
      .then((res) => res.arrayBuffer())
      .then((bytes) => WebAssembly.compile(bytes));
  }
  return modulePromise;
}

/**
 * Register the browser zstd decoder with `@workflow/core` (idempotent).
 * Call this before hydrating payloads that may be zstd-compressed; the
 * actual WASM compile + decode happens lazily on first use.
 */
export function ensureZstdDecoderRegistered(): void {
  if (registered) return;
  registered = true;
  registerZstdDecoder(async (payload) => {
    const { decompressBytes } = await import('@tootallnate/zstd-wasm');
    const wasmModule = await loadWasmModule();
    return decompressBytes(wasmModule, payload);
  });
}
