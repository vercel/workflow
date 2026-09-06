import { join as posixJoin } from 'pathe';
import type { NestBuilderOptions } from './builder.js';

/**
 * Injection token for the resolved {@link WorkflowModuleOptions}.
 *
 * Exported so an application (or a test) can inject the options the module was
 * configured with:
 *
 * ```typescript
 * constructor(
 *   @Inject(WORKFLOW_MODULE_OPTIONS) private options: WorkflowModuleOptions
 * ) {}
 * ```
 */
export const WORKFLOW_MODULE_OPTIONS = 'WORKFLOW_MODULE_OPTIONS';

/**
 * Legacy alias for {@link WORKFLOW_MODULE_OPTIONS}.
 * @deprecated Use `WORKFLOW_MODULE_OPTIONS`.
 */
export const WORKFLOW_OPTIONS = 'WORKFLOW_OPTIONS';

export interface WorkflowModuleOptions extends NestBuilderOptions {
  /**
   * Skip building workflow bundles on startup. The bundles must then already
   * exist, produced by `workflow-nest build`.
   *
   * Defaults to `true` when the `VERCEL` environment variable is set (the
   * Build Output produced by `workflow-nest build --vercel` already contains
   * them, and the deployed filesystem is read-only), and `false` otherwise.
   */
  skipBuild?: boolean;
  /**
   * Route prefix the workflow endpoints are reachable under, when the app is
   * not served from the origin root.
   *
   * Set this to the same value passed to `app.setGlobalPrefix()`, or to the
   * sub-path a reverse proxy mounts the app on. Without it the SDK generates
   * callback and webhook URLs at the origin root while NestJS serves the routes
   * under the prefix, so every queue delivery 404s and runs never progress.
   *
   * The prefix is applied to generated URLs only. NestJS already applies a
   * global prefix to the controller's own path, so this option must not be
   * duplicated there.
   *
   * @example '/api'
   */
  basePath?: string;
  /**
   * Start the target World's background workers with the application, and stop
   * them on shutdown.
   *
   * Self-hosted Worlds (`@workflow/world-postgres`, for example) run pollers
   * that have to be started explicitly; without them runs are created and never
   * picked up. Leave this off when deploying to Vercel, where the platform
   * drives the queue, or when the application starts the World itself.
   *
   * @default false
   */
  manageWorldLifecycle?: boolean;
  /**
   * Preload the generated bundles during startup instead of on the first
   * request. Turning this off moves roughly a megabyte of module evaluation
   * onto the first queue delivery.
   *
   * @default true
   */
  preloadBundles?: boolean;
}

/**
 * Factory-based configuration for {@link WorkflowModule.forRootAsync}.
 */
export interface WorkflowModuleAsyncOptions {
  /** Modules whose exported providers the factory injects. */
  imports?: unknown[];
  /** Providers passed to `useFactory`, in order. */
  inject?: unknown[];
  /** Returns the module options, possibly asynchronously. */
  useFactory: (
    ...args: never[]
  ) => WorkflowModuleOptions | Promise<WorkflowModuleOptions>;
}

const DEFAULT_OUT_DIR = '.nestjs/workflow';

const BASE_PATH_SYMBOL = Symbol.for('@workflow/core/basePath');

type GlobalWithBasePath = typeof globalThis &
  Record<symbol, string | undefined>;

/**
 * Publish the route prefix the SDK generates callback and webhook URLs under.
 *
 * This writes the same well-known symbol as `setWorkflowBasePath` in
 * `@workflow/utils`. It is reimplemented here rather than imported so the
 * runtime entry of this package keeps its dependency surface minimal.
 */
export function setWorkflowBasePath(basePath: string): void {
  (globalThis as GlobalWithBasePath)[BASE_PATH_SYMBOL] = basePath;
}

/** Read back the prefix the SDK is currently generating URLs under. */
export function getWorkflowBasePath(): string {
  return (globalThis as GlobalWithBasePath)[BASE_PATH_SYMBOL] ?? '';
}

/**
 * Normalize a base path to `''` or `/segment` with no trailing slash, so it can
 * be concatenated onto an origin without producing a double or missing slash.
 */
export function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath) return '';
  const trimmed = basePath.trim();
  if (trimmed === '' || trimmed === '/') return '';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, '');
}

export interface ResolvedWorkflowModuleOptions extends WorkflowModuleOptions {
  workingDir: string;
  outDir: string;
  basePath: string;
  skipBuild: boolean;
  preloadBundles: boolean;
  manageWorldLifecycle: boolean;
}

/**
 * Apply the option defaults that depend on the environment, so the module, the
 * controller, and the CLI all resolve them the same way.
 */
export function resolveModuleOptions(
  options: WorkflowModuleOptions = {},
  env: Record<string, string | undefined> = process.env
): ResolvedWorkflowModuleOptions {
  const workingDir = options.workingDir ?? process.cwd();
  return {
    ...options,
    // `watch` never worked here: the builder discards the esbuild contexts
    // `createCombinedBundle` hands back in watch mode, so nothing rebuilds and
    // the contexts leak. Pin it off until it is implemented.
    watch: false,
    workingDir,
    outDir: options.outDir ?? posixJoin(workingDir, DEFAULT_OUT_DIR),
    basePath: normalizeBasePath(options.basePath),
    // On Vercel the bundles ship inside the Build Output and the filesystem is
    // read-only, so an in-process build can only fail.
    skipBuild: options.skipBuild ?? Boolean(env.VERCEL),
    preloadBundles: options.preloadBundles ?? true,
    manageWorldLifecycle: options.manageWorldLifecycle ?? false,
  };
}

export { DEFAULT_OUT_DIR };
