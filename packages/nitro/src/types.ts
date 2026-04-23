export interface ModuleOptions {
  /** @internal */
  _vite?: boolean;

  /**
   * Directories to scan for workflows and steps.
   *
   * By default, `workflows/` directory will be scanned from root and all layer source dirs.
   */
  dirs?: string[];

  /**
   * Enable workflow TypeScript plugin in generated tsconfig.json
   * @default false
   */
  typescriptPlugin?: boolean;

  /**
   * Node.js runtime version for Vercel Functions.
   * @example "nodejs22.x"
   * @example "nodejs24.x"
   */
  runtime?: string;

  /**
   * Controls how source maps are emitted for workflow bundles. Accepts the
   * same values as esbuild's `sourcemap` option: `true`/`'inline'` (default
   * for step/workflow bundles), `'linked'`, `'external'`, `'both'`, or
   * `false` to omit source maps.
   *
   * Set to `false` for smaller function bundles — useful for staying under
   * the Vercel 250MB function size limit — at the cost of stack traces that
   * point at generated code instead of your source files.
   *
   * Can also be set via the `WORKFLOW_SOURCEMAP` environment variable.
   */
  sourcemap?: boolean | 'inline' | 'linked' | 'external' | 'both';
}

declare module 'nitro/types' {
  interface NitroOptions {
    workflow?: ModuleOptions;
  }
}

// @ts-expect-error (legacy)
declare module 'nitropack' {
  interface NitroOptions {
    workflow?: ModuleOptions;
  }
}
