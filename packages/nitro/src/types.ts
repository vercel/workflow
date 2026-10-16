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
   * Set to `false` for smaller function bundles (useful for staying under
   * the Vercel 250MB function size limit) at the cost of stack traces that
   * point at generated code instead of your source files.
   *
   * Can also be set via the `WORKFLOW_SOURCEMAP` environment variable.
   */
  sourcemap?: boolean | 'inline' | 'linked' | 'external' | 'both';

  /**
   * Embed the workflow observability dashboard in-process on this server,
   * served at `/_workflow` (configurable). The UI runs inside the same Nitro
   * process, with no separate server or port.
   *
   * - `true` / `false`: force the dashboard on or off.
   * - `{ enabled, path }`: toggle and/or change the mount path.
   *
   * Defaults to **on in dev, off in production builds**. When disabled the
   * route is never registered, so production bundles carry no `@workflow/web`
   * import and pay zero bundle-size or startup cost. Never mounted for Vercel
   * deploys (use the hosted Vercel dashboard there).
   *
   * @default nitro.options.dev
   */
  dashboard?: boolean | { enabled?: boolean; path?: string };

  /**
   * Start the World when the server boots, through a Nitro server plugin that
   * calls `ensureWorldStarted()` from `workflow/runtime`. A self-hosted World
   * (local, Postgres) re-enqueues the runs that were in flight when the server
   * last stopped, so sleeping, hook-waiting and mid-step runs resume after a
   * restart without waiting for the next workflow operation.
   *
   * Defaults to **on in production builds, off in dev**: a dev server's
   * in-flight runs usually belong to code that has since been edited, and
   * replaying them against the new code fails with a replay divergence. Never
   * registered for Vercel deploys, where the queue redelivers instead.
   *
   * Set to `false` to start the World yourself, for example from one instance
   * of a multi-instance deployment.
   *
   * @default !nitro.options.dev
   */
  startWorld?: boolean;
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
