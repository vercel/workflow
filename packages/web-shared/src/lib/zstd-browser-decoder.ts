/**
 * Browser zstd decoder for the o11y read path.
 *
 * The Web `DecompressionStream` has no zstd support, so `@workflow/core`'s
 * `hydrateDataWithKey` delegates zstd inflation to the decoder exported by
 * this module, backed by the `@tootallnate/zstd-wasm` single-file WASM decoder.
 *
 * The package leaves WASM sourcing to the caller; we resolve the shipped
 * `zstd.wasm` as a bundler asset (`new URL(..., import.meta.url)`, the same
 * pattern the trace-viewer Worker uses) and compile it once, lazily — the
 * WASM is fetched only the first time a zstd payload is actually decoded.
 */
let modulePromise: Promise<WebAssembly.Module> | undefined;

function loadWasmModule(): Promise<WebAssembly.Module> {
  if (!modulePromise) {
    const url = new URL('@tootallnate/zstd-wasm/zstd.wasm', import.meta.url);
    modulePromise = fetch(url)
      .then((res) => res.arrayBuffer())
      .then((bytes) => WebAssembly.compile(bytes));
  }
  return modulePromise;
}

/**
 * Decode zstd in browsers. The WASM compile + decode remains lazy and the
 * compiled module is reused for subsequent payloads.
 */
export async function decompressZstdInBrowser(
  payload: Uint8Array
): Promise<Uint8Array> {
  const { decompressBytes } = await import('@tootallnate/zstd-wasm');
  const wasmModule = await loadWasmModule();
  return decompressBytes(wasmModule, payload);
}
