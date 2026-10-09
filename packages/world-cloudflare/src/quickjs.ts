/**
 * Supply precompiled QuickJS WebAssembly modules to `@workflow/core`.
 *
 * Workers forbid compiling WebAssembly from bytes at runtime, which is what
 * core does by default (`WebAssembly.compile(quickjsWasm)`). Wrangler instead
 * compiles `.wasm`/`.so` imports at deploy time and hands the Worker
 * `WebAssembly.Module`s. Core caches its compiled assets in a process-wide
 * singleton; seeding that singleton with these modules makes core skip its own
 * compile step.
 *
 * The key and shape mirror `getCompiledAssets()` in
 * `packages/core/src/runtime/quickjs-runtime.ts`. A proper hook in core would
 * replace this (see the proposal's open questions).
 */
const ASSETS_KEY = Symbol.for('@workflow/core//quickjsCompiledAssets/v1');

export interface QuickJSModules {
  quickjs: WebAssembly.Module;
  encoding: WebAssembly.Module;
  headers: WebAssembly.Module;
  url: WebAssembly.Module;
  structuredClone: WebAssembly.Module;
}

declare namespace WebAssembly {
  type Module = {};
}

export function installQuickJSModules(modules: QuickJSModules): void {
  (globalThis as Record<symbol, unknown>)[ASSETS_KEY] = {
    promise: Promise.resolve({
      wasm: modules.quickjs,
      extensions: [
        { name: 'encoding', wasm: modules.encoding },
        { name: 'headers', wasm: modules.headers },
        { name: 'url', wasm: modules.url },
        {
          name: 'structured-clone',
          wasm: modules.structuredClone,
          initFn: 'qjs_ext_structured_clone_init',
        },
      ],
    }),
  };
}
