import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as importedUndici from 'undici';

export type Undici = typeof importedUndici;

/**
 * The undici this package builds its dispatchers from, and the `fetch` that
 * dispatches through them when the runtime's own `fetch` would not.
 *
 * On Node, `fetch` is `undefined`: the global `fetch` honors the `dispatcher`
 * option, and staying on it keeps requests visible to the runtime's fetch
 * instrumentation (see instrumentedFetch).
 *
 * Bun breaks both halves of that. Its global `fetch` ignores `dispatcher`, and
 * a bare `undici` specifier resolves to Bun's built-in module even when the
 * package is installed, whose dispatcher classes are stubs (no `compose`, no
 * `dispatch`). Every agent, retry policy, deadline and pool limit configured in
 * http-client.ts is inert there. So under Bun this resolves the installed
 * package itself and dispatches through its `fetch`, which runs undici's own
 * HTTP stack on Bun's `node:net`/`node:tls`/`node:http2` and honors all of it.
 *
 * Falls back to the imported module and the global `fetch` (every dispatcher
 * setting inert, but requests still work) when the package cannot be loaded,
 * or on a Bun older than MIN_BUN_VERSION.
 */
export interface UndiciRuntime {
  undici: Undici;
  fetch: Undici['fetch'] | undefined;
}

/**
 * Oldest Bun on which undici's `fetch` is usable. On 1.3.x it never finishes
 * reading a response body of 64 KiB or more: headers arrive and the body stream
 * stalls indefinitely, while `undici.request` reads the same body fine. Event
 * log pages routinely exceed that, so routing there would turn a degraded
 * transport into a hung one. Measured: bodies of 65536 bytes and up stall on
 * 1.3.4 through 1.3.11, and complete on 1.4.0 and 1.4.2.
 */
export const MIN_BUN_VERSION: readonly [number, number] = [1, 4];

function isBunAtLeast(
  version: string,
  [major, minor]: readonly [number, number]
) {
  const [vMajor = 0, vMinor = 0] = version.split('.').map(Number);
  return vMajor > major || (vMajor === major && vMinor >= minor);
}

function canCompose(undici: Undici): boolean {
  return typeof undici.Agent?.prototype?.compose === 'function';
}

/**
 * Loads the installed `undici` package by a path Bun does not redirect to its
 * built-in module. `undici/index.js` is the package's own entry point (it
 * publishes no `exports` map, so the subpath is addressable), and Bun only
 * special-cases the bare specifier.
 *
 * The specifier is built at runtime so bundlers do not trace a second copy of
 * undici into the output; a bundled build already gets the real package through
 * the static import. Resolution starts from this package's own location, where
 * a strict (pnpm) layout puts its `undici`, and falls back to the app root for
 * a CJS re-bundle, where `import.meta.url` is empty.
 */
export function loadInstalledUndici(): Undici | undefined {
  const specifier = ['undici', 'index.js'].join('/');
  const bases = [
    () => import.meta.url,
    () => pathToFileURL(`${process.cwd()}/package.json`).href,
  ];
  for (const base of bases) {
    try {
      return createRequire(
        /* webpackIgnore: true */
        /* turbopackIgnore: true */
        base()
      )(specifier) as Undici;
    } catch {
      // Try the next base; no base resolving falls back to the built-in.
    }
  }
  return undefined;
}

/**
 * Pure selection logic, separated from the process globals so a test can drive
 * every branch.
 */
export function selectUndiciRuntime(
  bunVersion: string | undefined,
  imported: Undici,
  loadInstalled: () => Undici | undefined
): UndiciRuntime {
  if (bunVersion === undefined || !isBunAtLeast(bunVersion, MIN_BUN_VERSION)) {
    return { undici: imported, fetch: undefined };
  }
  const undici = canCompose(imported) ? imported : loadInstalled();
  if (!undici || !canCompose(undici)) {
    return { undici: imported, fetch: undefined };
  }
  return { undici, fetch: undici.fetch };
}

/**
 * Resolved once at module load: it depends only on the runtime and on what is
 * installed, and http-client.ts needs the classes at module scope.
 */
export const undiciRuntime: UndiciRuntime = selectUndiciRuntime(
  process.versions.bun,
  importedUndici,
  loadInstalledUndici
);

/**
 * The dispatcher classes from the selected undici, under the names (and types)
 * the package's own exports use, so callers swap one import for another.
 */
export const Agent: typeof importedUndici.Agent = undiciRuntime.undici.Agent;
export type Agent = importedUndici.Agent;
export const RetryAgent: typeof importedUndici.RetryAgent =
  undiciRuntime.undici.RetryAgent;
export type RetryAgent = importedUndici.RetryAgent;
export const DecoratorHandler: typeof importedUndici.DecoratorHandler =
  undiciRuntime.undici.DecoratorHandler;
/**
 * The selected undici's `fetch` if a request carrying `dispatcher` should go
 * through it, otherwise `undefined` (use the global `fetch`).
 *
 * Besides the runtime check, the dispatcher itself has to be able to dispatch.
 * A caller-supplied `config.dispatcher` built from a bare `undici` import under
 * Bun is a built-in stub with no `dispatch()`: undici would throw on it, while
 * Bun's global `fetch` ignores it and sends the request. Keep that behavior for
 * such a dispatcher rather than turning it into a failure.
 */
export function undiciFetchFor(
  dispatcher: unknown
): Undici['fetch'] | undefined {
  if (!undiciRuntime.fetch) return undefined;
  if (
    dispatcher !== undefined &&
    typeof (dispatcher as { dispatch?: unknown } | null)?.dispatch !==
      'function'
  ) {
    return undefined;
  }
  return undiciRuntime.fetch;
}

/**
 * `fetch` for a request carrying an undici `dispatcher`: the selected undici's
 * `fetch` where the global one would drop the dispatcher (see undiciFetchFor),
 * otherwise the global `fetch`, looked up per call so framework patches and
 * test stubs still apply.
 */
export function fetchWithDispatcher(
  input: string,
  init: Omit<RequestInit, 'dispatcher'> & { dispatcher?: unknown }
): Promise<Response> {
  // The dispatcher is typed `unknown` throughout this package (see
  // APIConfig.dispatcher), and undici's RequestInit / Response are
  // structurally the WHATWG ones.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyInit = init as any;
  const viaUndici = undiciFetchFor(init.dispatcher);
  return viaUndici
    ? (viaUndici(input, anyInit) as unknown as Promise<Response>)
    : fetch(input, anyInit);
}

/**
 * `undici.request` for a request carrying `dispatcher`: the selected undici's
 * under the same conditions as fetchWithDispatcher, otherwise the imported
 * module's (Bun's built-in, which ignores the dispatcher as its `fetch` does).
 */
export function requestFor(dispatcher: unknown): Undici['request'] {
  return undiciFetchFor(dispatcher)
    ? undiciRuntime.undici.request
    : importedUndici.request;
}
