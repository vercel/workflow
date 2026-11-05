/**
 * Supply precompiled QuickJS WebAssembly modules to `@workflow/core`.
 *
 * Workers forbid compiling WebAssembly from bytes at runtime, which is what
 * core does by default (`WebAssembly.compile(quickjsWasm)`). Wrangler instead
 * compiles `.wasm`/`.so` imports at deploy time and hands the Worker
 * `WebAssembly.Module`s, which core accepts through
 * `setPrecompiledQuickJSModules()`.
 */
import { setPrecompiledQuickJSModules } from '@workflow/core/runtime';

/**
 * The QuickJS runtime and its native extensions, imported from the
 * `quickjs-wasi` release that `@workflow/core` embeds:
 *
 * ```ts
 * import quickjs from 'quickjs-wasi/quickjs.wasm';
 * import encoding from 'quickjs-wasi/encoding.so';
 * // ...headers.so, url.so, structured-clone.so
 * ```
 */
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
  setPrecompiledQuickJSModules({
    quickjs: modules.quickjs,
    extensions: {
      encoding: modules.encoding,
      headers: modules.headers,
      url: modules.url,
      'structured-clone': modules.structuredClone,
    },
  });
}
