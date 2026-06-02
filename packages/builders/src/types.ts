export const validBuildTargets = [
  'standalone',
  'vercel-build-output-api',
  'next',
  'nest',
  'sveltekit',
  'astro',
] as const;
export type BuildTarget = (typeof validBuildTargets)[number];

/**
 * Source map emission mode for generated workflow bundles. Matches esbuild's
 * `sourcemap` option vocabulary:
 *
 * - `true` / `'linked'`: write a separate `.map` file and add a `sourceMappingURL` comment
 * - `'inline'`: emit a base64-encoded source map at the end of the bundle
 * - `'external'`: write a separate `.map` file without the comment
 * - `'both'`: emit both inline and external source maps
 * - `false`: omit source maps entirely
 */
export type SourcemapMode = boolean | 'inline' | 'linked' | 'external' | 'both';

/**
 * Common configuration options shared across all builder types.
 */
interface BaseWorkflowConfig {
  watch?: boolean;
  dirs: string[];
  workingDir: string;
  /**
   * Project root used for package and workspace module-specifier resolution
   * during SWC transforms. Defaults to `workingDir`.
   */
  projectRoot?: string;

  // Optionally generate a client library for workflow execution. The preferred
  // method of using workflow is to use a loader within a framework (like
  // NextJS) that resolves client bindings on the fly.
  clientBundlePath?: string;

  externalPackages?: string[];

  workflowManifestPath?: string;

  // Optional prefix for debug files (e.g., "_" for Astro to ignore them)
  debugFilePrefix?: string;

  // Optional directory where diagnostics artifacts should be written.
  // The workflow manifest is written to workflows-manifest.json inside this dir.
  diagnosticsDir?: string;

  // Optional framework output directory, used by builders that mirror framework
  // artifact locations.
  distDir?: string;

  // Suppress informational logs emitted by createWorkflowsBundle()
  // (e.g. intermediate/final workflow bundle timing logs).
  suppressCreateWorkflowsBundleLogs?: boolean;

  // Suppress esbuild warnings emitted by createWorkflowsBundle().
  suppressCreateWorkflowsBundleWarnings?: boolean;

  // Suppress informational logs emitted by createWebhookBundle().
  suppressCreateWebhookBundleLogs?: boolean;

  // Suppress informational logs emitted by createManifest().
  suppressCreateManifestLogs?: boolean;

  // Node.js runtime version for Vercel Functions (e.g., "nodejs22.x", "nodejs24.x")
  runtime?: string;

  /**
   * Controls how source maps are emitted for workflow bundles. Accepts the
   * same values as esbuild's `sourcemap` option.
   *
   * Default is `'inline'` for the step bundle and intermediate workflow
   * bundle (gives readable stack traces for step errors and workflow VM
   * errors). Setting `false` omits source maps entirely, which produces
   * smaller bundles — useful for staying under the Vercel 250MB function
   * limit — at the cost of stack traces that reference generated code.
   *
   * `'external'` and `'linked'` write a separate `.map` file; use these
   * when you want to ship source maps to observability tooling but keep
   * them out of the function bundle.
   *
   * Can also be set via the `WORKFLOW_SOURCEMAP` environment variable;
   * config wins over env var, env var wins over the default.
   */
  sourcemap?: SourcemapMode;
}

/**
 * Configuration for standalone (CLI-based) builds.
 */
export interface StandaloneConfig extends BaseWorkflowConfig {
  buildTarget: 'standalone';
  stepsBundlePath: string;
  workflowsBundlePath: string;
  webhookBundlePath: string;
}

/**
 * Configuration for Vercel Build Output API builds.
 */
export interface VercelBuildOutputConfig extends BaseWorkflowConfig {
  buildTarget: 'vercel-build-output-api';
  stepsBundlePath: string;
  workflowsBundlePath: string;
  webhookBundlePath: string;
}

/**
 * Configuration for Next.js builds.
 */
export interface NextConfig extends BaseWorkflowConfig {
  buildTarget: 'next';
  // Next.js builder computes paths dynamically, so these are not used
  stepsBundlePath: string;
  workflowsBundlePath: string;
  webhookBundlePath: string;
}

/**
 * Configuration for SvelteKit builds.
 */
export interface SvelteKitConfig extends BaseWorkflowConfig {
  buildTarget: 'sveltekit';
  // SvelteKit builder computes paths dynamically, so these are not used
  stepsBundlePath: string;
  workflowsBundlePath: string;
  webhookBundlePath: string;
}

/**
 * Configuration for Astro builds.
 */
export interface AstroConfig extends BaseWorkflowConfig {
  buildTarget: 'astro';
  // Astro builder computes paths dynamically, so these are not used
  stepsBundlePath: string;
  workflowsBundlePath: string;
  webhookBundlePath: string;
}

/**
 * Configuration for NestJS builds.
 */
export interface NestConfig extends BaseWorkflowConfig {
  buildTarget: 'nest';
  // NestJS builder computes paths dynamically, so these are not used
  stepsBundlePath: string;
  workflowsBundlePath: string;
  webhookBundlePath: string;
}

/**
 * Discriminated union of all builder configuration types.
 */
export type WorkflowConfig =
  | StandaloneConfig
  | VercelBuildOutputConfig
  | NextConfig
  | NestConfig
  | SvelteKitConfig
  | AstroConfig;

export function isValidBuildTarget(
  target: string | undefined
): target is BuildTarget {
  return !!target && validBuildTargets.includes(target as BuildTarget);
}
