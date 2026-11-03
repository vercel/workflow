let buildersModulePromise: Promise<typeof import('@workflow/builders')> | null =
  null;

/**
 * Loads `@workflow/builders`, which is ESM-only, from this CommonJS package.
 * The import is hidden from TypeScript inside `eval` so it is not compiled to
 * `require()`, which fails on Node.js versions without `require(esm)` support.
 */
export function loadBuildersModule(): Promise<
  typeof import('@workflow/builders')
> {
  buildersModulePromise ??=
    // biome-ignore lint/security/noGlobalEval: Preserve the ESM import in this CommonJS package.
    eval('import("@workflow/builders")') as Promise<
      typeof import('@workflow/builders')
    >;
  return buildersModulePromise;
}
