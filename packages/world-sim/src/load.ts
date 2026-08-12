/**
 * Loading a built bundle, separated from building one.
 *
 * These two halves have very different dependency footprints. Building pulls
 * in `@workflow/builders`, and through it SWC and esbuild — tens of megabytes
 * of native binaries. Loading needs nothing but `import()`.
 *
 * Keeping them in one module meant anything that wanted to *run* a bundle also
 * dragged the whole compiler into its graph. That is fine in a CLI and
 * expensive in a deployed function, so the split is the package's way of
 * letting a consumer take the runtime half alone: `@workflow/world-sim`
 * re-exports this file, while `buildSimBundle` lives behind
 * `@workflow/world-sim/build`.
 */

import { pathToFileURL } from 'node:url';

/**
 * Import a built bundle's `POST` handler.
 *
 * Deliberately eager (unlike `@workflow/vitest`, which defers the import so
 * `vi.mock` can still intercept step dependencies): a scenario wants the
 * module graph settled before the clock is patched and the first delivery
 * runs, so that import-time work never lands in the middle of a measured
 * sequence.
 *
 * The path is only known at runtime — it is either a file this process wrote
 * seconds ago or one `next build` left on disk — so the ignore hints are
 * load-bearing wherever a bundler is in the graph. Without them a bundler
 * tries to resolve the specifier at build time and fails with "expression is
 * too dynamic". They are inert comments under plain Node.
 */
export async function loadFlowHandler(
  flowBundlePath: string
): Promise<(req: Request) => Promise<Response>> {
  const mod = await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */
    pathToFileURL(flowBundlePath).href
  );
  const handler = mod.POST;
  if (typeof handler !== 'function') {
    throw new Error(
      `Bundle at ${flowBundlePath} does not export a POST handler. Did the build succeed?`
    );
  }
  return handler as (req: Request) => Promise<Response>;
}
