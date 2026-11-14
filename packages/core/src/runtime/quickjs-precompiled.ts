import { globalSingleton } from '@workflow/utils';

/**
 * Precompiled QuickJS WebAssembly modules supplied by the host.
 *
 * Some runtimes forbid compiling WebAssembly from bytes at runtime (Cloudflare
 * Workers among them): there, `WebAssembly.compile(bytes)` throws, and the
 * platform compiles `.wasm` imports at deploy time instead, handing the program
 * ready `WebAssembly.Module`s. A host on such a runtime passes those modules
 * here before the first workflow invocation, and the QuickJS engine uses them
 * instead of compiling its embedded binaries.
 *
 * The modules must be compiled from the same `quickjs-wasi` release that this
 * version of `@workflow/core` embeds.
 */
export interface PrecompiledQuickJSModules {
  /** The main QuickJS runtime (`quickjs.wasm`). */
  quickjs: object;
  /**
   * Native extensions, keyed by extension name: `encoding`, `headers`, `url`
   * and `structured-clone`. Every extension the engine loads must be present.
   */
  extensions: Record<string, object>;
}

// On `globalThis` (see `globalSingleton`): the QuickJS engine is loaded lazily
// and may live in another bundler layer than the host's setup code.
const provided = globalSingleton(
  '@workflow/core//quickjsPrecompiledModules',
  1,
  () => ({ modules: undefined as PrecompiledQuickJSModules | undefined })
);

/**
 * Supply precompiled QuickJS modules (see {@link PrecompiledQuickJSModules}).
 * Call once, at startup, before any workflow runs. Has no effect on a QuickJS
 * engine that has already compiled its modules in this process.
 */
export function setPrecompiledQuickJSModules(
  modules: PrecompiledQuickJSModules
): void {
  provided.modules = modules;
}

/** The modules supplied by {@link setPrecompiledQuickJSModules}, if any. */
export function getPrecompiledQuickJSModules():
  | PrecompiledQuickJSModules
  | undefined {
  return provided.modules;
}
